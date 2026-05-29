/**
 * AudiobookExport — audiobook export UI (D7).
 *
 * Launched from the hub's export-btn → setView('export').
 * Provides: format selection, quality/bitrate select, metadata (title/author)
 * + cover drop, a Start button, streamed progress, and a Download button
 * enabled on completion.
 *
 * Subscribes via useBookProgress (C3) for export_progress / export_complete.
 * On complete, enables Download which fetches the Blob via useDownloadExport
 * and saves via platform.filesystem.saveFile with the correct extension.
 *
 * data-testids match wireframe-06, consumed by S10 (d7.spec.ts):
 *   export-format, export-metadata (+ cover-drop), export-action (+ export-status,
 *   start-export-btn, download-btn)
 */
import { useCallback, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBookProgress } from '@/lib/hooks/useBookProgress';
import { useBook, useDownloadExport, useStartExport } from '@/lib/hooks/useBooks';
import type {
  BookErrorEvent,
  ExportBitrate,
  ExportCompleteEvent,
  ExportFormat,
  ExportProgressEvent,
} from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import { useBooksStore } from '@/stores/booksStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const FORMAT_LABELS: Record<ExportFormat, string> = {
  m4b: 'M4B Audiobook',
  mp3_single: 'MP3 (single file)',
  mp3_per_chapter: 'MP3 per chapter (ZIP)',
};

const FORMAT_EXT: Record<ExportFormat, string> = {
  m4b: '.m4b',
  mp3_single: '.mp3',
  mp3_per_chapter: '.zip',
};

type ExportPhase = 'idle' | 'running' | 'complete' | 'error';

// ─── Component ────────────────────────────────────────────────────────────────

export function AudiobookExport() {
  const selectedBookId = useBooksStore((s) => s.selectedBookId);
  const setView = useBooksStore((s) => s.setView);

  const { data: book } = useBook(selectedBookId);

  // ── Form state ───────────────────────────────────────────────────────────────
  const [format, setFormat] = useState<ExportFormat>('m4b');
  const [bitrate, setBitrate] = useState<ExportBitrate>('128k');
  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // ── Export state ─────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<ExportPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // ── Hooks ─────────────────────────────────────────────────────────────────────
  const startExport = useStartExport();
  const downloadExport = useDownloadExport();

  // ── SSE handlers ─────────────────────────────────────────────────────────────

  const onExportProgress = useCallback((event: ExportProgressEvent) => {
    setProgress(event.progress);
    if ('message' in event && typeof (event as any).message === 'string') {
      setStatusMessage((event as any).message as string);
    }
  }, []);

  const onExportComplete = useCallback(
    (_event: ExportCompleteEvent) => {
      setProgress(100);
      setPhase('complete');
      setStatusMessage('Export complete');
    },
    [],
  );

  const onError = useCallback((event: BookErrorEvent) => {
    setPhase('error');
    setErrorMessage(event.message);
  }, []);

  useBookProgress(selectedBookId ?? '', {
    onExportProgress,
    onExportComplete,
    onError,
  });

  // ── Handlers ─────────────────────────────────────────────────────────────────

  async function handleStartExport() {
    if (!selectedBookId) return;
    setPhase('running');
    setProgress(0);
    setStatusMessage('Starting export...');
    setErrorMessage('');

    try {
      await startExport.mutateAsync({
        bookId: selectedBookId,
        data: {
          format,
          bitrate,
          title: title || undefined,
          author: author || undefined,
        },
      });
    } catch (err: unknown) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Export failed');
    }
  }

  async function handleDownload() {
    if (!selectedBookId || phase !== 'complete') return;
    try {
      await downloadExport.mutateAsync({
        bookId: selectedBookId,
        bookTitle: title || book?.title || 'audiobook',
        format,
      });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function handleCoverDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setCoverFile(file);
    }
  }

  function handleCoverInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setCoverFile(file);
    }
  }

  const isRunning = phase === 'running' || startExport.isPending;
  const isComplete = phase === 'complete';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Export Audiobook</h1>
          {book?.title && (
            <p className="text-sm text-muted-foreground mt-0.5">{book.title}</p>
          )}
        </div>
        <Button variant="ghost" onClick={() => setView('overview')}>
          Back to overview
        </Button>
      </div>

      <div className="flex gap-4 items-start">
        {/* Left column: format + quality */}
        <div className="flex flex-col gap-4 flex-1">
          {/* Format selection */}
          <Card>
            <CardContent className="p-4">
              <h2 className="text-lg font-semibold mb-3">Format</h2>
              <div
                data-testid="export-format"
                className="flex flex-col gap-2"
                role="radiogroup"
                aria-label="Export format"
              >
                {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((fmt) => (
                  <label
                    key={fmt}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                      format === fmt
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/40',
                    )}
                  >
                    <input
                      type="radio"
                      name="export-format"
                      value={fmt}
                      checked={format === fmt}
                      onChange={() => setFormat(fmt)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                        format === fmt ? 'border-primary' : 'border-muted-foreground',
                      )}
                    >
                      {format === fmt && (
                        <span className="w-2 h-2 rounded-full bg-primary" />
                      )}
                    </span>
                    <div>
                      <div className="font-medium text-sm">{FORMAT_LABELS[fmt]}</div>
                      <div className="text-xs text-muted-foreground">{FORMAT_EXT[fmt]}</div>
                    </div>
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Quality */}
          <Card>
            <CardContent className="p-4">
              <h2 className="text-lg font-semibold mb-3">Quality</h2>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bitrate-select" className="text-sm">
                  Bitrate
                </Label>
                <Select
                  value={bitrate}
                  onValueChange={(val) => setBitrate(val as ExportBitrate)}
                >
                  <SelectTrigger id="bitrate-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="64k">64 kbps</SelectItem>
                    <SelectItem value="128k">128 kbps</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right column: metadata + action */}
        <div className="flex flex-col gap-4 flex-1">
          {/* Metadata */}
          <Card>
            <CardContent className="p-4">
              <h2 className="text-lg font-semibold mb-3">Metadata</h2>
              <div
                data-testid="export-metadata"
                className="flex flex-col gap-3"
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-title" className="text-sm">
                    Title
                  </Label>
                  <Input
                    id="export-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={book?.title ?? 'Book title'}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-author" className="text-sm">
                    Author
                  </Label>
                  <Input
                    id="export-author"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder={book?.author ?? 'Author name'}
                  />
                </div>

                {/* Cover drop zone */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm">Cover image</Label>
                  <div
                    data-testid="cover-drop"
                    className={cn(
                      'relative flex flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center cursor-pointer transition-colors',
                      coverFile
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-accent/20',
                    )}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleCoverDrop}
                    onClick={() => coverInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && coverInputRef.current?.click()}
                    aria-label="Drop cover image here or click to select"
                  >
                    {coverFile ? (
                      <p className="text-sm font-medium">{coverFile.name}</p>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Drop cover image here
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          or click to browse
                        </p>
                      </>
                    )}
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleCoverInput}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action + status */}
          <Card>
            <CardContent className="p-4">
              <div
                data-testid="export-action"
                className="flex flex-col gap-3"
              >
                {/* Status area */}
                <div data-testid="export-status" className="min-h-[56px]">
                  {phase === 'idle' && (
                    <p className="text-sm text-muted-foreground">
                      Ready to export. Choose your format and click Start.
                    </p>
                  )}

                  {phase === 'running' && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                          {statusMessage || 'Exporting…'}
                        </p>
                        <Badge variant="secondary">{Math.round(progress)}%</Badge>
                      </div>
                      <Progress value={progress} className="h-2" />
                    </div>
                  )}

                  {phase === 'complete' && (
                    <div className="flex items-center gap-2">
                      <Badge variant="default" className="border-green-700 text-green-400">
                        Done
                      </Badge>
                      <p className="text-sm text-muted-foreground">{statusMessage}</p>
                    </div>
                  )}

                  {phase === 'error' && (
                    <p className="text-sm text-destructive">{errorMessage}</p>
                  )}
                </div>

                {/* Buttons */}
                <div className="flex gap-2">
                  <Button
                    data-testid="start-export-btn"
                    onClick={handleStartExport}
                    disabled={isRunning}
                    className="flex-1"
                  >
                    {isRunning ? 'Exporting…' : 'Start Export'}
                  </Button>

                  <Button
                    data-testid="download-btn"
                    variant="outline"
                    disabled={!isComplete || downloadExport.isPending}
                    onClick={handleDownload}
                    className="flex-1"
                  >
                    {downloadExport.isPending
                      ? 'Downloading…'
                      : `Download ${FORMAT_EXT[format]}`}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
