import type { ComponentId } from '@eventkit/shared';
import type { AnyRunner } from '../types';

/** Real installers per component (filled in per platform). */
export function realRunners(): Partial<Record<ComponentId, AnyRunner>> {
  return {};
}
