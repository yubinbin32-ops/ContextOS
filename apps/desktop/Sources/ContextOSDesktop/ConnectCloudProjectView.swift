import SwiftUI

struct ConnectCloudProjectView: View {
    @ObservedObject var store: GraphStore
    @Environment(\.dismiss) private var dismiss

    @State private var cloudUrl: String = ""
    @State private var projectId: String = ""
    @State private var token: String = ""
    @State private var isConnecting = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            // Header
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(ContextOSTheme.focus.opacity(0.15))
                        .frame(width: 40, height: 40)
                    Image(systemName: "cloud.fill")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(ContextOSTheme.focus)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(store.text("connectCloudProject"))
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundStyle(ContextOSTheme.ink)
                    Text(store.activeLocale == "zh-Hans" ? "连接到远程 ContextOS 云端服务并载入空间架构图" : "Connect to a remote ContextOS Cloud Hub and import architecture graph")
                        .font(.system(size: 11))
                        .foregroundStyle(ContextOSTheme.muted)
                }
            }

            Divider()

            // Form
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(store.text("cloudUrl"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ContextOSTheme.ink)
                    TextField(store.activeLocale == "zh-Hans" ? "例如: http://localhost:8787 或 https://hub.contextos.run" : "e.g. http://localhost:8787 or https://hub.contextos.run", text: $cloudUrl)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(store.text("projectId"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ContextOSTheme.ink)
                    TextField(store.activeLocale == "zh-Hans" ? "例如: my-team-project" : "e.g. my-team-project", text: $projectId)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(store.text("authToken"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ContextOSTheme.ink)
                    SecureField(store.activeLocale == "zh-Hans" ? "可选，用于私有云鉴权" : "Optional bearer token for private cloud", text: $token)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                }
            }

            if let errorMessage {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(ContextOSTheme.failure)
                        .font(.system(size: 12))
                    Text(errorMessage)
                        .font(.system(size: 11))
                        .foregroundStyle(ContextOSTheme.failure)
                        .lineLimit(2)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ContextOSTheme.failure.opacity(0.1))
                .cornerRadius(6)
            }

            Spacer()

            // Actions
            HStack {
                Button(store.text("cancelDownload")) {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button {
                    connect()
                } label: {
                    HStack(spacing: 6) {
                        if isConnecting {
                            ProgressView()
                                .controlSize(.small)
                            Text(store.text("connecting"))
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                            Text(store.text("connectAndImport"))
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(cloudUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                          projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                          isConnecting)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440, height: 320)
    }

    private func connect() {
        let trimmedUrl = cloudUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPid = projectId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedUrl.isEmpty && !trimmedPid.isEmpty else { return }

        isConnecting = true
        errorMessage = nil

        Task {
            do {
                try await store.connectCloudProject(
                    cloudUrl: trimmedUrl,
                    projectId: trimmedPid,
                    token: trimmedToken.isEmpty ? nil : trimmedToken
                )
                await MainActor.run {
                    isConnecting = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isConnecting = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}
