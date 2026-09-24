import React from 'react';
import {
  Layers,
  PanelLeft,
  GitBranch,
  Settings2,
  Code2,
  Puzzle,
  FileText,
  Database,
  ShieldCheck,
  AlertTriangle,
  BookOpen,
  Hammer,
  FlaskConical,
  Archive,
  Clock,
  CircleDashed,
  Sparkles,
  Braces,
} from 'lucide-react';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
}

export const BlockKindIcon: React.FC<IconProps & { kind: string }> = ({
  kind,
  size = 10,
  color,
  className,
}) => {
  const strokeWidth = 2.2;
  const style = color ? { color } : undefined;

  switch (kind) {
    case 'ui':
      return <PanelLeft size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'flow':
      return <GitBranch size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'service':
      return <Settings2 size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'function':
      return <Code2 size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'integration':
      return <Puzzle size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'data':
      return <FileText size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'database':
      return <Database size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'test':
    case 'checkpoint':
      return <ShieldCheck size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'risk':
      return <AlertTriangle size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'principle':
    case 'decision':
    case 'requirement':
    case 'product':
      return <BookOpen size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    default:
      return <Layers size={size} strokeWidth={strokeWidth} style={style} className={className} />;
  }
};

export const DeliveryStateIcon: React.FC<IconProps & { state: string }> = ({
  state,
  size = 9,
  color,
  className,
}) => {
  const strokeWidth = 2.2;
  const style = color ? { color } : undefined;

  switch (state) {
    case 'complete':
      // 1:1 with Apple checkmark.circle.fill: filled circle with white checkmark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill={color || 'currentColor'}
          className={`shrink-0 ${className || ''}`}
        >
          <circle cx="8" cy="8" r="8" />
          <path
            d="M12.2 5.3a.75.75 0 0 0-1.06-.04L7.25 9.17 4.88 6.8a.75.75 0 0 0-1.06 1.06l2.9 2.9a.75.75 0 0 0 1.08-.02l4.36-4.38a.75.75 0 0 0 .04-1.06z"
            fill="#ffffff"
          />
        </svg>
      );
    case 'implementing':
      return <Hammer size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'verifying':
      return <FlaskConical size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'deprecated':
      return <Archive size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    case 'planned':
      return <Clock size={size} strokeWidth={strokeWidth} style={style} className={className} />;
    default:
      return <CircleDashed size={size} strokeWidth={strokeWidth} style={style} className={className} />;
  }
};

export const GhostBadge: React.FC<{ stateColor: string; className?: string }> = ({
  stateColor,
  className,
}) => (
  <span
    className={`px-[4px] py-[1.5px] text-[7px] font-black font-mono rounded-full flex items-center gap-[3px] leading-none shrink-0 ${
      className || ''
    }`}
    style={{
      color: stateColor,
      backgroundColor: `${stateColor}1f`,
    }}
  >
    <Sparkles size={7.5} strokeWidth={2.4} />
    <span>GHOST</span>
  </span>
);

export const ASTBadge: React.FC<{ focusColor: string; className?: string }> = ({
  focusColor,
  className,
}) => (
  <span
    className={`px-[4px] py-[1.5px] text-[7px] font-black font-mono rounded-full flex items-center gap-[3px] leading-none shrink-0 ${
      className || ''
    }`}
    style={{
      color: focusColor,
      backgroundColor: `${focusColor}1f`,
    }}
  >
    <Braces size={7.5} strokeWidth={2.4} />
    <span>AST</span>
  </span>
);

export const HealthWarningIcon: React.FC<{ color: string; size?: number; className?: string }> = ({
  color,
  size = 9,
  className,
}) => (
  <AlertTriangle
    size={size}
    strokeWidth={2.5}
    style={{ color }}
    className={`shrink-0 ${className || ''}`}
  />
);
