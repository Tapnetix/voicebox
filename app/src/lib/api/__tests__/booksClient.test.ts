import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api/client';

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body), blob: () => Promise.resolve(new Blob()) } as Response);

describe('books client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GET /books', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok([]) as never);
    await apiClient.listBooks();
    expect(f.mock.calls[0][0]).toMatch(/\/books$/);
  });

  it('POST /books/import sends multipart with the file', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({ id: 'b1' }) as never);
    await apiClient.importBook(new File(['x'], 'silo.epub'), { model_size: '1.7B' });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/books\/import$/);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it('PATCH /segments/{id} sends the diff as JSON', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({ id: 's1', emotion: 'angry' }) as never);
    await apiClient.updateSegment('s1', { emotion: 'angry', emotion_intensity: 0.8 });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/segments\/s1$/);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ emotion: 'angry' });
  });

  it('builds the per-book SSE url', () => {
    expect(apiClient.getBookEventsUrl('b1')).toMatch(/\/events\/books\/b1$/);
  });

  it('POST /books/{id}/export posts the format', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({ task_id: 't', status: 'exporting' }) as never);
    await apiClient.startExport('b1', { format: 'm4b', title: 'Silo' });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ format: 'm4b' });
  });
});
