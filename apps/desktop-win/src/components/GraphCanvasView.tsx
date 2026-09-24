// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/GraphCanvasView.swift

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasScene, ChainEnvelopeGeometry, chainEnvelopeContains } from '../canvasScene';
import { GraphStore } from '../graphStore';
import { BlockItem, GraphSelection, LinkItem } from '../models';
import { CGPoint, CGRect, CGSize } from '../networkLayout';
import { ContextOSTheme } from '../theme';
import {
  BlockKindIcon,
  DeliveryStateIcon,
  GhostBadge,
  ASTBadge,
  HealthWarningIcon,
} from './SFSymbols';

interface GraphCanvasViewProps {
  store: GraphStore;
}

export const GraphCanvasView: React.FC<GraphCanvasViewProps> = ({ store }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState<CGSize>({ width: 1200, height: 800 });
  const [scene, setScene] = useState<CanvasScene>(CanvasScene.empty());
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [cameraStartOffset, setCameraStartOffset] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [motionTime, setMotionTime] = useState(0);

  // Resize observer for container viewport
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Scene compilation matching Swift rebuildScene
  useEffect(() => {
    const compiled = CanvasScene.compile(store.snapshot, store.hiddenKinds);
    setScene(compiled);

    if (!store.hasRestoredCamera) {
      fitAll(compiled, viewportSize);
    }
  }, [
    store.snapshot.project.id,
    store.snapshot.project.graphRevision,
    store.snapshot.changeSequence,
    store.snapshotPresentationID,
    Array.from(store.hiddenKinds).sort().join(','),
  ]);

  // Motion animation loop (30fps)
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();
    const loop = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      setMotionTime((prev) => prev + dt);
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Fit all / fit selection reactions
  useEffect(() => {
    fitAll(scene, viewportSize);
  }, [store.overviewFitRequestID]);

  useEffect(() => {
    fitSelection(scene, viewportSize);
  }, [store.focusRequestID]);

  const fitAll = useCallback(
    (currentScene: CanvasScene, vp: CGSize) => {
      if (Object.keys(currentScene.layout.positions).length === 0 || vp.width <= 0 || vp.height <= 0) return;
      const sWidth = currentScene.layout.size.width;
      const sHeight = currentScene.layout.size.height;
      const scale = Math.min(1.0, Math.max(0.28, Math.min((vp.width - 36) / sWidth, (vp.height - 36) / sHeight)));
      const offset = {
        width: (vp.width - sWidth * scale) / 2,
        height: (vp.height - sHeight * scale) / 2,
      };
      store.setCamera(scale, offset);
    },
    [store]
  );

  const fitSelection = useCallback(
    (currentScene: CanvasScene, vp: CGSize) => {
      if (!store.focusTarget) return;
      let ids: Set<string>;
      if (store.focusTarget.type === 'chain') {
        const visibleBlockIDs = new Set(currentScene.blocks.map((b) => b.id));
        ids = new Set(store.chainBlockIDs(store.focusTarget.id).filter((id) => visibleBlockIDs.has(id)));
      } else if (store.focusTarget.type === 'plan') {
        const visibleBlockIDs = new Set(currentScene.blocks.map((b) => b.id));
        ids = new Set(
          Array.from(store.relatedBlockIDs(store.focusTarget)).filter((id) => visibleBlockIDs.has(id))
        );
      } else {
        return;
      }

      const bounds = currentScene.bounds(ids);
      if (!bounds) return;
      const scale = Math.min(
        1.25,
        Math.max(0.4, Math.min((vp.width - 54) / bounds.width, (vp.height - 54) / bounds.height))
      );
      const midX = bounds.x + bounds.width / 2;
      const midY = bounds.y + bounds.height / 2;
      const offset = {
        width: vp.width / 2 - midX * scale,
        height: vp.height / 2 - midY * scale,
      };
      store.setCamera(scale, offset);
    },
    [store]
  );

  const relatedBlockIDs = useMemo(() => {
    if (!store.selection) return null;
    switch (store.selection.type) {
      case 'block':
        return scene.connectedComponent(store.selection.id);
      case 'chain':
        return new Set(
          store.chainBlockIDs(store.selection.id).filter((id) => scene.blocks.some((b) => b.id === id))
        );
      case 'plan':
        return new Set(
          Array.from(store.relatedBlockIDs(store.selection)).filter((id) =>
            scene.blocks.some((b) => b.id === id)
          )
        );
      case 'link': {
        const link = scene.links.find((l) => l.id === store.selection!.id);
        return link ? new Set([link.sourceId, link.targetId]) : new Set<string>();
      }
      case 'decision':
        return new Set<string>();
    }
  }, [store.selection, scene]);

  // Mouse wheel pan & zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setIsWheeling(true);
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = setTimeout(() => setIsWheeling(false), 150);

    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = -e.deltaY * 0.005;
      const zoomFactor = delta >= 0 ? 1 + delta : 1 / (1 - delta);
      const newScale = Math.min(1.8, Math.max(0.25, store.canvasScale * zoomFactor));

      const rectBounds = containerRef.current?.getBoundingClientRect();
      const cursorX = e.clientX - (rectBounds?.left || 0);
      const cursorY = e.clientY - (rectBounds?.top || 0);

      const worldX = (cursorX - store.canvasOffset.width) / store.canvasScale;
      const worldY = (cursorY - store.canvasOffset.height) / store.canvasScale;

      const newOffset = {
        width: cursorX - worldX * newScale,
        height: cursorY - worldY * newScale,
      };
      store.setCamera(newScale, newOffset);
    } else {
      // Pan
      store.setCanvasOffset({
        width: store.canvasOffset.width - e.deltaX,
        height: store.canvasOffset.height - e.deltaY,
      });
    }
  };

  // Drag pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Check if clicked directly on canvas background
    const target = e.target as HTMLElement;
    if (target.closest('.block-card-interactive') || target.closest('.link-hit') || target.closest('.chain-hit')) {
      return;
    }
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setCameraStartOffset({ ...store.canvasOffset });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    store.setCanvasOffset({
      width: cameraStartOffset.width + dx,
      height: cameraStartOffset.height + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setDragStart(null);
  };

  // Double click zoom
  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.block-card-interactive')) return;
    const delta = e.altKey ? -0.32 : 0.42;
    store.zoom(delta);
  };

  // Click on background clears selection
  const handleCanvasClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.block-card-interactive') || target.closest('.link-hit') || target.closest('.chain-hit')) {
      return;
    }
    store.clearSelection();
  };

  // --- SVG Paths Generators ---

  const roundedContourPath = (points: CGPoint[], radius: number): string => {
    if (points.length <= 2) return '';
    const offset = (from: CGPoint, toward: CGPoint, dist: number): CGPoint => {
      const dx = toward.x - from.x;
      const dy = toward.y - from.y;
      const len = Math.max(0.001, Math.hypot(dx, dy));
      return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
    };

    const corners = points.map((p, index) => {
      const prev = points[(index - 1 + points.length) % points.length];
      const next = points[(index + 1) % points.length];
      const applied = Math.min(
        radius,
        Math.hypot(prev.x - p.x, prev.y - p.y) / 2,
        Math.hypot(next.x - p.x, next.y - p.y) / 2
      );
      return {
        start: offset(p, prev, applied),
        ctrl: p,
        end: offset(p, next, applied),
      };
    });

    let d = `M ${corners[0].start.x} ${corners[0].start.y} `;
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      if (i > 0) d += `L ${c.start.x} ${c.start.y} `;
      d += `Q ${c.ctrl.x} ${c.ctrl.y}, ${c.end.x} ${c.end.y} `;
      const nextC = corners[(i + 1) % corners.length];
      d += `L ${nextC.start.x} ${nextC.start.y} `;
    }
    d += 'Z';
    return d;
  };

  const chainEnvelopeSvgPath = (envelope: ChainEnvelopeGeometry): string => {
    let d = '';
    for (const contour of envelope.contours) {
      if (contour.length > 2) {
        d += roundedContourPath(contour, 10 + envelope.expansion * 0.25) + ' ';
      }
    }
    return d;
  };

  const streetSvgPath = (points: CGPoint[]): string => {
    if (points.length === 0) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x} ${points[i].y}`;
    }
    return d;
  };

  const gridSpacing = Math.max(12, Math.min(36, 24 * store.canvasScale));
  const phaseX = ((store.canvasOffset.width % gridSpacing) + gridSpacing) % gridSpacing;
  const phaseY = ((store.canvasOffset.height % gridSpacing) + gridSpacing) % gridSpacing;

  return (
    <div
      ref={containerRef}
      className="relative flex-1 h-full overflow-hidden select-none bg-white cursor-grab active:cursor-grabbing"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onClick={handleCanvasClick}
    >
      {/* 1. Grid Layer (hairstroke dot pattern) */}
      <svg
        className="absolute inset-0 pointer-events-none"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="dot-grid"
            x={phaseX}
            y={phaseY}
            width={gridSpacing}
            height={gridSpacing}
            patternUnits="userSpaceOnUse"
          >
            <circle cx={1} cy={1} r={1} fill={ContextOSTheme.hairline} opacity={0.5} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dot-grid)" />
      </svg>

      {/* World Container transformed by Camera */}
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: scene.layout.size.width,
          height: scene.layout.size.height,
          transform: `translate(${store.canvasOffset.width}px, ${store.canvasOffset.height}px) scale(${store.canvasScale})`,
          transition: isDragging || isWheeling ? 'none' : 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* SVG Drawing Layer for Envelopes, Links, and Flow */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width={scene.layout.size.width}
          height={scene.layout.size.height}
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 2. Chain Envelope Layer */}
          {store.snapshot.chains.map((chain) => {
            const memberIDs = scene.chainNodes[chain.id] || [];
            const envelope = scene.chainEnvelopes[chain.id];
            if (memberIDs.length === 0 || !envelope) return null;

            const color = store.chainColor(chain.id);
            const selected = store.highlightedChainIDs.has(chain.id);
            const subdued = store.highlightedChainIDs.size > 0 && !selected;
            const fillOpacity = subdued ? 0.012 : selected ? 0.085 : 0.025;
            const outerOpacity = subdued ? 0.05 : selected ? 0.18 : 0.09;
            const strokeOpacity = subdued ? 0.12 : selected ? 0.96 : 0.62;

            const pathD = chainEnvelopeSvgPath(envelope);

            return (
              <g key={`envelope-${chain.id}`} style={{ transition: 'opacity 0.3s ease' }}>
                {/* Envelope Fill */}
                <path d={pathD} fill={color} fillOpacity={fillOpacity} fillRule="evenodd" style={{ transition: 'fill-opacity 0.3s ease' }} />
                {/* Envelope Outer Glow/Stroke */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={color}
                  strokeOpacity={outerOpacity}
                  strokeWidth={selected ? 6.0 : 4.0}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Envelope Inner Main Stroke */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={color}
                  strokeOpacity={strokeOpacity}
                  strokeWidth={selected ? 2.8 : 1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {/* 3. Link Layer (Street lines & arrows) */}
          {scene.links.map((link) => {
            const points = scene.layout.routes[link.id];
            if (!points || points.length < 2) return null;

            const isRelated =
              relatedBlockIDs === null ||
              (relatedBlockIDs.has(link.sourceId) && relatedBlockIDs.has(link.targetId));
            const opacity = isRelated ? 0.86 : 0.1;
            const color = ContextOSTheme.linkKindColor(link.kind);
            const isDashed = ['depends_on', 'validates', 'constrains', 'supersedes'].includes(link.kind);

            const pathD = streetSvgPath(points);

            // Arrow calculation at route endpoint
            const end = points[points.length - 1];
            const start = points[points.length - 2];
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const arrowSize = 7;
            const a1 = {
              x: end.x - Math.cos(angle - 0.55) * arrowSize,
              y: end.y - Math.sin(angle - 0.55) * arrowSize,
            };
            const a2 = {
              x: end.x - Math.cos(angle + 0.55) * arrowSize,
              y: end.y - Math.sin(angle + 0.55) * arrowSize,
            };
            const arrowD = `M ${a1.x} ${a1.y} L ${end.x} ${end.y} L ${a2.x} ${a2.y}`;

            return (
              <g key={`link-${link.id}`} style={{ transition: 'opacity 0.3s ease' }}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={color}
                  strokeOpacity={opacity}
                  strokeWidth={isRelated ? 1.7 : 1.2}
                  strokeDasharray={isDashed ? '6,4' : undefined}
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                />
                <path
                  d={arrowD}
                  fill="none"
                  stroke={color}
                  strokeOpacity={opacity}
                  strokeWidth={1.6}
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                />
              </g>
            );
          })}

          {/* 4. Chain Motion Flow Layer */}
          {store.snapshot.chains.map((chain, index) => {
            const envelope = scene.chainEnvelopes[chain.id];
            if (!envelope) return null;
            const selected = store.highlightedChainIDs.has(chain.id);
            const color = store.chainColor(chain.id);
            const signature = index % 3;
            const pathD = chainEnvelopeSvgPath(envelope);

            // Animate dash along the boundary
            const dashPhase = -motionTime * (18 + signature * 5);
            const dash = signature === 0 ? '9,14' : signature === 1 ? '4,8,13,8' : '2,7,2,15';

            return (
              <path
                key={`flow-${chain.id}`}
                d={pathD}
                fill="none"
                stroke={color}
                strokeOpacity={selected ? 0.72 : 0.34}
                strokeWidth={selected ? 2.0 : 1.2}
                strokeDasharray={dash}
                strokeDashoffset={dashPhase}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </svg>

        {/* 5. Hit Layers (Link hit areas & Chain hit areas) */}
        <svg
          className="absolute inset-0 pointer-events-auto"
          width={scene.layout.size.width}
          height={scene.layout.size.height}
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Chain Hit Layer */}
          {store.snapshot.chains.map((chain) => {
            const envelope = scene.chainEnvelopes[chain.id];
            if (!envelope || envelope.contours.length === 0) return null;
            const pathD = chainEnvelopeSvgPath(envelope);
            return (
              <path
                key={`chain-hit-${chain.id}`}
                className="chain-hit cursor-pointer"
                d={pathD}
                fill="black"
                fillOpacity={0.0001}
                fillRule="evenodd"
                onClick={(e) => {
                  e.stopPropagation();
                  store.select({ type: 'chain', id: chain.id });
                }}
              >
                <title>{store.chainText(chain, 'title')}</title>
              </path>
            );
          })}

          {/* Link Hit Layer */}
          {scene.links.map((link) => {
            const points = scene.layout.routes[link.id];
            if (!points || points.length < 2) return null;
            const pathD = streetSvgPath(points);
            return (
              <path
                key={`link-hit-${link.id}`}
                className="link-hit cursor-pointer"
                d={pathD}
                fill="none"
                stroke="black"
                strokeOpacity={0.0001}
                strokeWidth={14}
                onClick={(e) => {
                  e.stopPropagation();
                  store.select({ type: 'link', id: link.id });
                }}
              >
                <title>{link.label || link.kind}</title>
              </path>
            );
          })}
        </svg>

        {/* 6. Block Cards Layer */}
        {scene.blocks.map((block) => {
          const pos = scene.layout.positions[block.id];
          if (!pos) return null;
          return (
            <BlockCardView
              key={block.id}
              block={block}
              position={pos}
              size={scene.cardSize}
              store={store}
              dimmed={relatedBlockIDs !== null && !relatedBlockIDs.has(block.id)}
            />
          );
        })}
      </div>
    </div>
  );
};

interface BlockCardViewProps {
  block: BlockItem;
  position: CGPoint;
  size: CGSize;
  store: GraphStore;
  dimmed: boolean;
}

const BlockCardView: React.FC<BlockCardViewProps> = ({ block, position, size, store, dimmed }) => {
  const isSelected = store.selection?.type === 'block' && store.selection.id === block.id;
  const isChanged = store.recentlyChangedRefs.has(`block:${block.id}`);
  const typeColor = ContextOSTheme.blockKindColor(block.kind);
  const stateColor = ContextOSTheme.deliveryColor(block.deliveryState);
  const isGhost = block.isGhost;
  const sources = store.sourceReferences(block.id);
  const hasFacade = sources.some((s) => s.symbol !== null && s.symbol !== undefined);
  const firstSymbol = sources.find((s) => s.symbol)?.symbol;
  const isUnhealthy = !['unknown', 'healthy'].includes(block.healthState);

  return (
    <div
      className="block-card-interactive absolute cursor-pointer select-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: isSelected ? 30 : 10,
        opacity: dimmed ? 0.13 : 1,
        transform: dimmed ? 'scale(0.96)' : isSelected ? 'scale(1.02)' : 'scale(1)',
        filter: dimmed ? 'grayscale(0.3)' : 'none',
        transition:
          'left 0.45s cubic-bezier(0.16, 1, 0.3, 1), top 0.45s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, filter 0.3s ease, box-shadow 0.2s ease, border-color 0.2s ease',
      }}
      onClick={(e) => {
        e.stopPropagation();
        store.select({ type: 'block', id: block.id });
      }}
      title={`${store.blockText(block, 'title')}\n${store.blockText(block, 'summary')}`}
    >
      <div
        className="relative w-full h-full p-[11px] flex flex-col rounded-[14px] bg-white overflow-hidden text-left hover:shadow-md transition-shadow duration-200"
        style={{
          backgroundColor: isGhost ? 'rgba(255, 255, 255, 0.72)' : '#ffffff',
          boxShadow: isSelected
            ? '0 10px 25px -5px rgba(0, 0, 0, 0.12), 0 8px 10px -6px rgba(0, 0, 0, 0.08)'
            : '0 2px 4px rgba(0, 0, 0, 0.045)',
          borderWidth: isChanged ? '3px' : isSelected ? '2px' : '1.1px',
          borderStyle: isGhost ? 'dashed' : 'solid',
          borderColor: isChanged
            ? ContextOSTheme.focus
            : isSelected
            ? typeColor
            : isGhost
            ? `${typeColor}60`
            : `${typeColor}48`,
        }}
      >
        {/* Left vertical color bar (4px) */}
        <div
          className="absolute left-0 top-[12px] bottom-[12px] w-[4px] rounded-r pointer-events-none"
          style={{
            backgroundColor: typeColor,
            opacity: isGhost ? 0.6 : 1.0,
          }}
        />

        {/* 1. Top Header Row (HStack(spacing: 6)) */}
        <div className="flex items-center gap-[6px] shrink-0 h-[15px] w-full">
          <BlockKindIcon kind={block.kind} size={10} color={typeColor} />
          <span
            className="text-[8px] font-bold font-mono tracking-[0.9px] leading-none uppercase shrink-0"
            style={{ color: typeColor }}
          >
            {block.kind}
          </span>

          <div className="flex-1 min-w-[4px]" />

          {/* GHOST / AST Badge */}
          {isGhost ? (
            <GhostBadge stateColor={stateColor} />
          ) : hasFacade ? (
            <ASTBadge focusColor={ContextOSTheme.focus} />
          ) : null}

          {/* Delivery Symbol */}
          <DeliveryStateIcon state={block.deliveryState} size={9} color={stateColor} />

          {/* Unhealthy Warning */}
          {isUnhealthy && (
            <HealthWarningIcon color={ContextOSTheme.healthColor(block.healthState)} size={9} />
          )}
        </div>

        {/* 2. Title (Spacing 7px in Swift) */}
        <div
          className="mt-[7px] text-[13px] font-semibold font-rounded leading-[1.25] text-[#111827] line-clamp-2 break-words"
          style={{ color: ContextOSTheme.ink }}
        >
          {store.blockText(block, 'title')}
        </div>

        {/* 3. Summary (Spacing 5px in Swift) */}
        <div
          className="mt-[5px] text-[9.5px] font-normal font-rounded leading-[1.35] text-[#64748b] line-clamp-2 break-words"
          style={{ color: ContextOSTheme.muted }}
        >
          {store.blockText(block, 'summary')}
        </div>

        {/* 4. Spacer(minLength: 0) */}
        <div className="flex-1 min-h-[4px]" />

        {/* 5. Bottom: Delivery State & Symbol Anchor */}
        <div className="flex items-center justify-between shrink-0 h-[13px] font-mono text-[7.5px] leading-none tracking-[0.6px]">
          <span className="font-bold uppercase" style={{ color: stateColor }}>
            {block.deliveryState}
          </span>
          {firstSymbol && (
            <span
              className="font-medium truncate max-w-[110px] text-[#64748b]"
              style={{ color: ContextOSTheme.muted }}
            >
              {firstSymbol}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
