import type { ComponentType } from 'react';

export interface UiFeature {
  id: string;
  label: string;
  slot: 'page' | 'toolbar';
  component: ComponentType;
}

export const uiFeatures: readonly UiFeature[] = [];
