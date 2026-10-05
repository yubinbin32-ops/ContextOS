#!/usr/bin/env python3
"""Recompute the historical four-arm comparison from published usage evidence."""
import argparse
import csv
import hashlib
import io
import json
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens")
ROLE_FIELDS = ("arm", "role", "input_tokens", "cached_input_tokens", "uncached_input_tokens",
               "output_tokens", "reasoning_output_tokens", "raw_tokens",
               "usd_base", "assistant_divisor", "main_equivalent_usd", "coverage")
COMPARISON_FIELDS = ("arm", "workflow", "peak_main_input_tokens", "main_raw_tokens",
                     "micro_raw_tokens", "cli_raw_tokens", "total_observed_raw_tokens",
                     "main_equivalent_tokens", "equivalent_token_reduction_percent",
                     "main_equivalent_usd", "equivalent_usd_reduction_percent",
                     "peak_main_context_reduction_percent", "coverage")

def fixed(value, places=12):
    with localcontext() as ctx:
        ctx.prec = 50
        result = Decimal(value.numerator) / Decimal(value.denominator) if isinstance(value, Fraction) else Decimal(value)
        return f"{result:.{places}f}"

def usage_sum(records, usage_key):
    keys = set().union(*(record[usage_key] for record in records))
    return {key: sum(record[usage_key].get(key, 0) for record in records) for key in keys}

def unique(records, key):
    seen = {}
    for record in records:
        identity = key(record)
        if identity in seen:
            assert seen[identity] == record, "Conflicting duplicate evidence"
        else:
            seen[identity] = record
    return list(seen.values())

def assert_usage(observed, expected, fields=FIELDS):
    for field in fields:
        assert observed[field] == expected[field], (field, observed[field], expected[field])
    assert observed["total_tokens"] == observed["input_tokens"] + observed["output_tokens"]
    assert 0 <= observed["cached_input_tokens"] <= observed["input_tokens"]

def csv_text(fields, rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()

def calculate(document):
    audits = document["audits"]
    assert document["accounting"]["assistant_divisor"] == 7
    assert document["accounting"]["rates_usd_per_million"] == {"uncached_input": "2", "cached_input": "0.1", "output": "10"}
    roles = {}
    peaks = {}
    for row in audits["main"]["rows"]:
        responses = unique(row["provider_response_records"], lambda r: r["response_id"])
        assert len(responses) == row["unique_response_ids"]
        summed = usage_sum(responses, "usage")
        assert_usage(summed, row["terminal_usage"], tuple(row["terminal_usage"]))
        assert_usage(summed, row["response_usage_sum"], tuple(row["response_usage_sum"]))
        states = unique(row["events_usage"], lambda r: json.dumps(r["total"], sort_keys=True))
        assert len(states) == row["unique_cumulative_states"]
        assert_usage(usage_sum(states, "last"), row["terminal_usage"])
        assert max(r["last"]["input_tokens"] for r in states) == row["peak_last_input"]
        assert max(r["usage"]["input_tokens"] for r in responses) == row["peak_last_input"]
        roles[(row["arm"], "Main")] = (summed, "complete observed response coverage")
        peaks[row["arm"]] = row["peak_last_input"]
    for row in audits["micro"]["rows"]:
        receipts = unique(row["records"], lambda r: r["receipt_id"])
        assert len(receipts) == row["unique_receipts"]
        original = usage_sum(receipts, "usage")
        assert original == row["totals"]
        started = sum(r["metrics"]["providerRequests"] for r in receipts)
        reported = sum(r["metrics"]["providerUsageCalls"] for r in receipts)
        assert (started, reported) == (row["provider_requests_started"], row["provider_usage_calls"])
        assert sum(r["metrics"]["estimatedUsageCalls"] for r in receipts) == row["estimated_usage_calls"] == 0
        assert all(r["reasoning_tokens"] is None for r in receipts)
        assert row["reasoning_tokens"] is None
        usage = {"input_tokens": original["promptTokens"],
                 "cached_input_tokens": original["cachedInputTokens"],
                 "output_tokens": original["completionTokens"],
                 "total_tokens": original["totalTokens"],
                 "reasoning_output_tokens": None}
        assert_usage(usage, usage)
        assert usage["input_tokens"] - usage["cached_input_tokens"] == original["uncachedInputTokens"]
        coverage = f"provider usage {reported}/{started}; missing usage unknown" if started != reported else f"provider usage {reported}/{started}"
        roles[(row["arm"], "Micro")] = (usage, coverage)
    cli = audits["cli"]
    states = unique(cli["records"], lambda r: json.dumps(r["cumulativeUsage"], sort_keys=True))
    assert len(states) == cli["uniqueCumulativeStates"] == 51
    summed = usage_sum(states, "lastUsage")
    assert_usage(summed, cli["terminalUsage"], tuple(cli["terminalUsage"]))
    assert_usage(summed, cli["sumOfUniqueLastUsage"], tuple(cli["sumOfUniqueLastUsage"]))
    roles[("D", "CLI")] = (summed, "51 unique states; terminal usage matched")
    role_rows = []
    raw, cost = {}, {}
    for (arm, role), (usage, coverage) in roles.items():
        uncached = usage["input_tokens"] - usage["cached_input_tokens"]
        base = (uncached * 2 + usage["cached_input_tokens"] * Fraction(1, 10) + usage["output_tokens"] * 10) / 1000000
        divisor = 1 if role == "Main" else 7
        raw[(arm, role)] = usage["total_tokens"]
        cost[(arm, role)] = base / divisor
        role_rows.append({"arm": arm, "role": role, "input_tokens": usage["input_tokens"],
                          "cached_input_tokens": usage["cached_input_tokens"], "uncached_input_tokens": uncached,
                          "output_tokens": usage["output_tokens"],
                          "reasoning_output_tokens": "unknown" if usage.get("reasoning_output_tokens") is None else usage["reasoning_output_tokens"],
                          "raw_tokens": usage["total_tokens"], "usd_base": fixed(base),
                          "assistant_divisor": divisor, "main_equivalent_usd": fixed(base / divisor),
                          "coverage": coverage})
    baseline_raw, baseline_cost = raw[("A", "Main")], cost[("A", "Main")]
    comparisons = []
    for arm, workflow in document["experiment"]["arms"].items():
        main = raw[(arm, "Main")]
        micro, worker = raw.get((arm, "Micro"), 0), raw.get((arm, "CLI"), 0)
        equivalent = main + Fraction(micro + worker, 7)
        usd = sum((cost.get((arm, role), Fraction(0)) for role in ("Main", "Micro", "CLI")), Fraction(0))
        comparisons.append({"arm": arm, "workflow": workflow, "peak_main_input_tokens": peaks[arm],
                            "main_raw_tokens": main, "micro_raw_tokens": micro, "cli_raw_tokens": worker,
                            "total_observed_raw_tokens": main + micro + worker,
                            "main_equivalent_tokens": fixed(equivalent),
                            "equivalent_token_reduction_percent": fixed((1 - equivalent / baseline_raw) * 100),
                            "main_equivalent_usd": fixed(usd),
                            "equivalent_usd_reduction_percent": fixed((1 - usd / baseline_cost) * 100),
                            "peak_main_context_reduction_percent": fixed((1 - Fraction(peaks[arm], peaks["A"])) * 100),
                            "coverage": "observed subtotal; D Micro 1 missing request unknown" if arm == "D" else "complete observed request coverage"})
    assert [raw[(a, "Main")] for a in "ABCD"] == [8016375, 6119582, 4993135, 1809566]
    assert raw[("C", "Micro")] == 734551 and raw[("D", "Micro")] == 3258709 and raw[("D", "CLI")] == 4393118
    return role_rows, comparisons

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate frozen CSV outputs and all published SHA-256 hashes")
    args = parser.parse_args()
    path = HERE / "historical-usage.json"
    source = path.read_text()
    assert "/Users/" not in source and "/private/" not in source
    document = json.loads(source)
    roles, comparisons = calculate(document)
    generated = {"usage-by-role.csv": csv_text(ROLE_FIELDS, roles),
                 "comparison.csv": csv_text(COMPARISON_FIELDS, comparisons)}
    if args.check:
        for filename, content in generated.items():
            assert (HERE / filename).read_text() == content, f"Stale generated CSV: {filename}"
        for line in (HERE / "SHA256SUMS").read_text().splitlines():
            expected, filename = line.split("  ", 1)
            assert hashlib.sha256((HERE / filename).read_bytes()).hexdigest() == expected, f"Frozen file changed: {filename}"
        print("PASS: response IDs, receipts, cumulative states, usage totals, CSVs and SHA-256 hashes")
    for row in roles:
        print(f'{row["arm"]} {row["role"]}: base USD={row["usd_base"]}; divisor={row["assistant_divisor"]}; equivalent USD={row["main_equivalent_usd"]}')
    for row in comparisons:
        print(f'{row["arm"]}: raw={row["total_observed_raw_tokens"]}; main-equivalent tokens={row["main_equivalent_tokens"]}; USD={row["main_equivalent_usd"]}; USD reduction={row["equivalent_usd_reduction_percent"]}%')
    print("D is an observed subtotal: one started Micro request has unknown usage; Micro reasoning fields remain unknown.")
    print("USD values use the user-specified comparison model, not a provider invoice.")

if __name__ == "__main__":
    main()
