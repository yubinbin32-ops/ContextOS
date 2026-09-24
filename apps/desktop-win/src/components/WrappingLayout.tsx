// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/WrappingHStackLayout.swift

import React from 'react';

interface WrappingLayoutProps {
  children: React.ReactNode;
  spacing?: number;
  rowSpacing?: number;
  className?: string;
}

export const WrappingHStackLayout: React.FC<WrappingLayoutProps> = ({
  children,
  spacing = 10,
  rowSpacing = 6,
  className = '',
}) => {
  return (
    <div
      className={`flex flex-wrap items-center ${className}`}
      style={{
        columnGap: `${spacing}px`,
        rowGap: `${rowSpacing}px`,
      }}
    >
      {children}
    </div>
  );
};
