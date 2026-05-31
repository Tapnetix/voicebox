import type { HealthResponse } from '@/lib/api/types';

/**
 * Derived view of which inference runtime the server is actually using, so the
 * UI can both name the engine (MLX vs PyTorch) and flag a slow fallback.
 *
 * The backend already distinguishes the runtime via `backend_type` ("mlx" /
 * "pytorch") and the human GPU label via `gpu_type` (e.g. "Metal (Apple
 * Silicon via MLX)" vs "MPS (Apple Silicon)"). On Apple Silicon, MLX (Metal) is
 * the fast path; the PyTorch/MPS path and plain CPU are markedly slower.
 */
export interface AccelerationInfo {
  /** Human-facing engine name, or undefined when the backend didn't report one. */
  engine?: 'MLX' | 'PyTorch';
  /** Backend's GPU label, e.g. "Metal (Apple Silicon via MLX)". */
  gpuType?: string;
  /** Apple Silicon running the PyTorch/MPS path instead of MLX — the slow fallback. */
  appleFallback: boolean;
  /** No GPU acceleration at all — CPU-only inference. */
  cpuOnly: boolean;
}

export function getAccelerationInfo(health: HealthResponse): AccelerationInfo {
  const engine =
    health.backend_type === 'mlx'
      ? 'MLX'
      : health.backend_type === 'pytorch'
        ? 'PyTorch'
        : undefined;
  const gpuType = health.gpu_type;
  // MPS in the GPU label means we're on Apple Silicon; if the engine isn't MLX
  // we're on the slower PyTorch path.
  const appleFallback = health.backend_type !== 'mlx' && !!gpuType && gpuType.includes('MPS');
  const cpuOnly = !health.gpu_available;
  return { engine, gpuType, appleFallback, cpuOnly };
}
