import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@/lib/api/types';
import { getAccelerationInfo } from '@/lib/acceleration';

function health(overrides: Partial<HealthResponse>): HealthResponse {
  return {
    status: 'healthy',
    model_loaded: false,
    gpu_available: true,
    ...overrides,
  } as HealthResponse;
}

describe('getAccelerationInfo', () => {
  it('reports MLX on the Apple Silicon fast path (no fallback)', () => {
    const info = getAccelerationInfo(
      health({ backend_type: 'mlx', gpu_type: 'Metal (Apple Silicon via MLX)' }),
    );
    expect(info.engine).toBe('MLX');
    expect(info.appleFallback).toBe(false);
    expect(info.cpuOnly).toBe(false);
  });

  it('flags the PyTorch/MPS fallback on Apple Silicon', () => {
    const info = getAccelerationInfo(
      health({ backend_type: 'pytorch', gpu_type: 'MPS (Apple Silicon)' }),
    );
    expect(info.engine).toBe('PyTorch');
    expect(info.appleFallback).toBe(true);
    expect(info.cpuOnly).toBe(false);
  });

  it('flags CPU-only when no GPU is available', () => {
    const info = getAccelerationInfo(
      health({ backend_type: 'pytorch', gpu_available: false, gpu_type: undefined }),
    );
    expect(info.cpuOnly).toBe(true);
    expect(info.appleFallback).toBe(false);
  });

  it('does not flag a fallback on CUDA', () => {
    const info = getAccelerationInfo(
      health({ backend_type: 'pytorch', gpu_type: 'CUDA (NVIDIA GeForce RTX 4090)' }),
    );
    expect(info.engine).toBe('PyTorch');
    expect(info.appleFallback).toBe(false);
    expect(info.cpuOnly).toBe(false);
  });
});
