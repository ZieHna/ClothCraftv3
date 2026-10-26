import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetSkeletonHandoff } from '../lib/useSkeletonGate';
import { installMatchMedia, setViewportWidth } from './viewport';

installMatchMedia();
afterEach(() => {
  cleanup();
  resetSkeletonHandoff(); // a skeleton left on screen by one test is not handed over to the next
  setViewportWidth(1280);
});
