// API Types matching backend Pydantic models
import type { LanguageCode } from '@/lib/constants/languages';

export type VoiceType = 'cloned' | 'preset' | 'designed';

export interface VoiceProfileCreate {
  name: string;
  description?: string;
  language: LanguageCode;
  voice_type?: VoiceType;
  preset_engine?: string;
  preset_voice_id?: string;
  design_prompt?: string;
  default_engine?: string;
  /** Free-form character prompt used by compose and the `/generate` personality-rewrite path. */
  personality?: string;
}

export interface VoiceProfileResponse {
  id: string;
  name: string;
  description?: string;
  language: string;
  avatar_path?: string;
  effects_chain?: EffectConfig[];
  voice_type: VoiceType;
  preset_engine?: string;
  preset_voice_id?: string;
  design_prompt?: string;
  default_engine?: string;
  personality?: string | null;
  generation_count: number;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

/** Response returned by /profiles/{id}/compose. */
export interface PersonalityTextResponse {
  text: string;
  model_size: string;
}

export interface PresetVoice {
  voice_id: string;
  name: string;
  gender: 'male' | 'female';
  language: string;
}

export interface ProfileSampleCreate {
  reference_text: string;
}

export interface ProfileSampleResponse {
  id: string;
  profile_id: string;
  audio_path: string;
  reference_text: string;
}

export interface EffectConfig {
  type: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface GenerationRequest {
  profile_id: string;
  text: string;
  language: LanguageCode;
  seed?: number;
  model_size?: '1.7B' | '0.6B' | '1B' | '3B';
  engine?:
    | 'qwen'
    | 'qwen_custom_voice'
    | 'luxtts'
    | 'chatterbox'
    | 'chatterbox_turbo'
    | 'tada'
    | 'kokoro';
  instruct?: string;
  /** When true and the profile has a personality prompt, input text is rewritten in-character before TTS. */
  personality?: boolean;
  max_chunk_chars?: number;
  crossfade_ms?: number;
  normalize?: boolean;
  effects_chain?: EffectConfig[];
}

export interface GenerationVersionResponse {
  id: string;
  generation_id: string;
  label: string;
  audio_path: string;
  effects_chain?: EffectConfig[];
  source_version_id?: string;
  is_default: boolean;
  created_at: string;
}

export interface GenerationResponse {
  id: string;
  profile_id: string;
  text: string;
  language: string;
  audio_path?: string;
  duration?: number;
  seed?: number;
  instruct?: string;
  engine?: string;
  model_size?: string;
  status: 'loading_model' | 'generating' | 'completed' | 'failed';
  error?: string;
  is_favorited?: boolean;
  created_at: string;
  versions?: GenerationVersionResponse[];
  active_version_id?: string;
}

export interface HistoryQuery {
  profile_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryResponse extends GenerationResponse {
  profile_name: string;
  versions?: GenerationVersionResponse[];
  active_version_id?: string;
}

export interface HistoryListResponse {
  items: HistoryResponse[];
  total: number;
}

export type WhisperModelSize = 'base' | 'small' | 'medium' | 'large' | 'turbo';

export type Qwen3ModelSize = '0.6B' | '1.7B' | '4B';

export type CaptureSource = 'dictation' | 'recording' | 'file';

/**
 * Snapshot of the accessibility-focused UI element at chord-start. Emitted
 * from Rust as part of the ``dictate:start`` payload so the frontend can
 * pass it back to ``paste_final_text`` once the final text is ready.
 */
export interface FocusSnapshot {
  pid: number;
  bundle_id: string | null;
  role: string | null;
}

export interface RefinementFlags {
  smart_cleanup: boolean;
  self_correction: boolean;
  preserve_technical: boolean;
}

export interface CaptureResponse {
  id: string;
  audio_path: string;
  source: CaptureSource;
  language?: string | null;
  duration_ms?: number | null;
  transcript_raw: string;
  transcript_refined?: string | null;
  stt_model?: string | null;
  llm_model?: string | null;
  refinement_flags?: RefinementFlags | null;
  created_at: string;
}

export interface CaptureListResponse {
  items: CaptureResponse[];
  total: number;
}

/**
 * Response of ``POST /captures``. Adds ``auto_refine`` and ``allow_auto_paste``
 * — the server's current settings captured at request time — so the client
 * can decide whether to chain a refine call and whether to fire the
 * synthetic-paste pipeline without relying on its own (possibly stale) copy
 * of capture_settings.
 */
export interface CaptureCreateResponse extends CaptureResponse {
  auto_refine: boolean;
  allow_auto_paste: boolean;
}

export interface CaptureRefineRequest {
  flags?: RefinementFlags;
  model_size?: Qwen3ModelSize;
}

export interface CaptureRetranscribeRequest {
  model?: WhisperModelSize;
  language?: LanguageCode;
}

export interface CaptureSettings {
  stt_model: WhisperModelSize;
  language: string;
  auto_refine: boolean;
  llm_model: Qwen3ModelSize;
  smart_cleanup: boolean;
  self_correction: boolean;
  preserve_technical: boolean;
  allow_auto_paste: boolean;
  default_playback_voice_id: string | null;
  /** Whether the global keyboard hotkey is armed. Off by default — turning
   *  this on triggers the macOS Input Monitoring TCC prompt. */
  hotkey_enabled: boolean;
  /** keytap key names. Defaults are platform-specific right-hand modifiers. */
  chord_push_to_talk_keys: string[];
  /** keytap key names. Toggle adds Space to the platform-specific PTT chord. */
  chord_toggle_to_talk_keys: string[];
}

export type CaptureSettingsUpdate = Partial<CaptureSettings>;

/**
 * One row in the dictation readiness checklist. ``model_name`` is the
 * canonical id understood by ``POST /models/download`` so the UI can wire a
 * one-click "Download" button without a second lookup.
 */
export interface ModelReadiness {
  ready: boolean;
  model_name: string;
  display_name: string;
  size: string;
  size_mb?: number | null;
}

/** Backend half of the dictation readiness check. The frontend combines this
 *  with TCC permission state into the full checklist used by useDictationReadiness. */
export interface CaptureReadinessResponse {
  stt: ModelReadiness;
  llm: ModelReadiness;
}

export interface GenerationSettings {
  max_chunk_chars: number;
  crossfade_ms: number;
  normalize_audio: boolean;
  autoplay_on_generate: boolean;
}

export type GenerationSettingsUpdate = Partial<GenerationSettings>;

export interface TranscriptionRequest {
  language?: LanguageCode;
  model?: WhisperModelSize;
}

export interface TranscriptionResponse {
  text: string;
  duration: number;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_downloaded?: boolean;
  model_size?: string;
  gpu_available: boolean;
  gpu_type?: string;
  vram_used_mb?: number;
  backend_type?: string;
  backend_variant?: string; // "cpu" or "cuda"
}

export interface CudaDownloadProgress {
  model_name: string;
  current: number;
  total: number;
  progress: number;
  filename?: string;
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  timestamp: string;
  error?: string;
}

export interface CudaStatus {
  available: boolean; // CUDA binary exists on disk
  active: boolean; // Currently running the CUDA binary
  binary_path?: string;
  downloading: boolean; // Download in progress
  download_progress?: CudaDownloadProgress;
}

export interface ModelProgress {
  model_name: string;
  current: number;
  total: number;
  progress: number;
  filename?: string;
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  timestamp: string;
  error?: string;
}

export interface ModelStatus {
  model_name: string;
  display_name: string;
  hf_repo_id?: string; // HuggingFace repository ID
  downloaded: boolean;
  downloading: boolean; // True if download is in progress
  size_mb?: number;
  loaded: boolean;
}

export interface HuggingFaceModelInfo {
  id: string;
  author: string;
  lastModified: string;
  pipeline_tag?: string;
  library_name?: string;
  downloads: number;
  likes: number;
  tags: string[];
  cardData?: {
    license?: string;
    language?: string[];
    pipeline_tag?: string;
  };
}

export interface ModelStatusListResponse {
  models: ModelStatus[];
}

export interface ModelDownloadRequest {
  model_name: string;
}

export interface ActiveDownloadTask {
  model_name: string;
  status: string;
  started_at: string;
  error?: string;
  progress?: number; // 0-100 percentage
  current?: number; // bytes downloaded
  total?: number; // total bytes
  filename?: string; // current file being downloaded
}

export interface ActiveGenerationTask {
  task_id: string;
  profile_id: string;
  text_preview: string;
  started_at: string;
}

export interface ActiveTasksResponse {
  downloads: ActiveDownloadTask[];
  generations: ActiveGenerationTask[];
}

export interface StoryCreate {
  name: string;
  description?: string;
}

export interface StoryResponse {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  item_count: number;
}

export interface StoryItemDetail {
  id: string;
  story_id: string;
  generation_id: string;
  version_id?: string;
  start_time_ms: number;
  track: number;
  trim_start_ms: number;
  trim_end_ms: number;
  created_at: string;
  profile_id: string;
  profile_name: string;
  text: string;
  language: string;
  audio_path: string;
  duration: number;
  seed?: number;
  instruct?: string;
  engine?: string;
  volume: number;
  generation_created_at: string;
  versions?: GenerationVersionResponse[];
  active_version_id?: string;
}

export interface StoryItemVolumeUpdate {
  volume: number;
}

export interface StoryItemVersionUpdate {
  version_id: string | null;
}

export interface StoryDetailResponse {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  items: StoryItemDetail[];
}

export interface StoryItemCreate {
  generation_id: string;
  start_time_ms?: number;
  track?: number;
}

export interface StoryItemUpdateTime {
  generation_id: string;
  start_time_ms: number;
}

export interface StoryItemBatchUpdate {
  updates: StoryItemUpdateTime[];
}

export interface StoryItemReorder {
  generation_ids: string[];
}

export interface StoryItemMove {
  start_time_ms: number;
  track: number;
}

export interface StoryItemTrim {
  trim_start_ms: number;
  trim_end_ms: number;
}

export interface StoryItemSplit {
  split_time_ms: number;
}

// Effects

export interface EffectPresetResponse {
  id: string;
  name: string;
  description?: string;
  effects_chain: EffectConfig[];
  is_builtin: boolean;
  created_at: string;
}

export interface EffectPresetCreate {
  name: string;
  description?: string;
  effects_chain: EffectConfig[];
}

export interface EffectPresetUpdate {
  name?: string;
  description?: string;
  effects_chain?: EffectConfig[];
}

export interface AvailableEffectParam {
  default: number;
  min: number;
  max: number;
  step: number;
  description: string;
}

export interface AvailableEffect {
  type: string;
  label: string;
  description: string;
  params: Record<string, AvailableEffectParam>;
}

export interface AvailableEffectsResponse {
  effects: AvailableEffect[];
}

export interface ApplyEffectsRequest {
  effects_chain: EffectConfig[];
  source_version_id?: string;
  label?: string;
  set_as_default?: boolean;
}

/* ─── Books ───────────────────────────────────────────────────────────── */

export type BookStatus =
  | 'imported'
  | 'analyzing'
  | 'analyzed'
  | 'generating'
  | 'completed'
  | 'error';

export type GenerationState = 'none' | 'partial' | 'ready' | 'error';

export type SegmentType = 'dialogue' | 'narration';

export type ExportFormat = 'm4b' | 'mp3_single' | 'mp3_per_chapter';

export type ExportBitrate = '64k' | '128k';

export type ExportChannels = 'mono' | 'stereo';

/** Lightweight profile summary used in voice-options picker. */
export interface VoiceProfileSummary {
  id: string;
  name: string;
  avatar_path?: string;
  voice_type: VoiceType;
  is_library: boolean;
}

export interface ChapterSummary {
  id: string;
  number: number;
  title: string;
  word_count: number;
  story_id?: string;
  generation_state: GenerationState;
}

export interface BookResponse {
  id: string;
  title: string;
  author?: string;
  source_format: string;
  cover_path?: string;
  status: BookStatus;
  chapter_count: number;
  created_at: string;
  updated_at: string;
}

export interface BookDetailResponse extends BookResponse {
  chapters: ChapterSummary[];
}

export interface BookAnalyzeResponse {
  book_id: string;
  task_id: string;
  status: 'analyzing';
}

export interface BookUpdateRequest {
  title?: string;
  author?: string;
  cover_path?: string;
}

export interface CharacterResponse {
  id: string;
  name: string;
  color: string;
  profile_id?: string;
  voice_type: string | null;
  voice_label: string | null;
  is_library: boolean;
  is_narrator: boolean;
  role?: string;
  gender?: string;
  age_range?: string;
  vocal_description?: string;
  archetype?: string;
  dialogue_count: number;
  confidence: number;
  aliases: string[];
}

export interface CharacterUpdateRequest {
  name?: string;
  color?: string;
  profile_id?: string;
  design_prompt?: string;
  preset_voice_id?: string;
  is_narrator?: boolean;
}

export interface CharacterMergeRequest {
  source_char_id: string;
}

export interface CharacterSplitRequest {
  new_name: string;
  segment_ids: string[];
}

export interface SegmentAudio {
  generation_id: string;
  status: string;
  audio_path?: string;
  duration_ms?: number;
}

export interface SegmentResponse {
  id: string;
  chapter_id: string;
  character_id: string;
  character_name: string;
  type: SegmentType;
  text: string;
  emotion: string;
  emotion_intensity: number;
  delivery?: string;
  order: number;
  audio: SegmentAudio;
}

export interface SegmentUpdateRequest {
  character_id?: string;
  emotion?: string;
  emotion_intensity?: number;
  delivery?: string;
  text?: string;
  type?: SegmentType;
}

export interface SegmentSplitRequest {
  at_offset: number;
}

export interface SegmentMergeRequest {
  segment_ids: string[];
}

export interface VoiceOptions {
  library: VoiceProfileSummary[];
  book: VoiceProfileSummary[];
  presets: PresetVoice[];
}

export interface CharacterPreviewRequest {
  text?: string;
  emotion?: string;
  profile_id?: string;
  preset_voice_id?: string;
  design_prompt?: string;
}

export interface CharacterPreviewResponse {
  generation_id: string;
  audio_path: string;
}

/** Body for POST /segments/{id}/preview — non-destructive emotion preview. */
export interface SegmentPreviewRequest {
  emotion?: string;
  instruct?: string;
}

/** Response from POST /segments/{id}/preview. */
export interface SegmentPreviewResponse {
  generation_id: string;
  audio_path: string;
}

export interface GenerateChapterRequest {
  engine?: string;
  model_size?: string;
  overwrite_errors?: boolean;
}

export interface GenerateChapterResponse {
  book_id: string;
  chapter_id: string;
  task_id: string;
  queued_segments: number;
}

export interface GenerateBookRequest {
  engine?: string;
  model_size?: string;
  overwrite_errors?: boolean;
}

export interface GenerateBookResponse {
  book_id: string;
  task_id: string;
  queued_segments: number;
}

export interface RegenerateSegmentRequest {
  emotion?: string;
  instruct?: string;
  seed?: number;
}

export interface RegenerateSegmentResponse {
  segment_id: string;
  generation_id: string;
  version_id: string;
  status: string;
}

export interface ChapterGenerationStatus {
  chapter_id: string;
  total: number;
  completed: number;
  errors: number;
  state: GenerationState;
}

export interface GenerationStatusResponse {
  chapters: ChapterGenerationStatus[];
  overall_progress: number;
}

export interface ExportRequest {
  format: ExportFormat;
  bitrate?: ExportBitrate;
  target_lufs?: number;
  channels?: ExportChannels;
  title?: string;
  author?: string;
  cover_path?: string;
}

export interface ExportResponse {
  book_id: string;
  task_id: string;
  status: 'exporting';
}

/* ─── Book SSE Events (contract-04) ──────────────────────────────────── */

export interface AnalysisProgressEvent {
  type: 'analysis_progress';
  stage: 'detect' | 'reconcile' | 'profile' | 'cast';
  progress: number;
  message?: string;
}

export interface CharacterDetectedEvent {
  type: 'character_detected';
  character: { id: string; name: string; [key: string]: unknown };
  total: number;
}

export interface AnalysisCompleteEvent {
  type: 'analysis_complete';
  character_count: number;
  chapter_count: number;
}

export interface GenerationProgressEvent {
  type: 'generation_progress';
  chapter_id: string;
  completed: number;
  errors: number;
  total: number;
  overall_progress: number;
}

export interface GenerationCompleteEvent {
  type: 'generation_complete';
  chapter_id?: string;
}

export interface ExportProgressEvent {
  type: 'export_progress';
  progress: number;
  stage?: string;
}

export interface ExportCompleteEvent {
  type: 'export_complete';
  download_path: string;
  filename: string;
}

export interface BookErrorEvent {
  type: 'error';
  stage: string;
  message: string;
}

export type BookProgressEvent =
  | AnalysisProgressEvent
  | CharacterDetectedEvent
  | AnalysisCompleteEvent
  | GenerationProgressEvent
  | GenerationCompleteEvent
  | ExportProgressEvent
  | ExportCompleteEvent
  | BookErrorEvent;

/* ─── MCP ─────────────────────────────────────────────────────────────── */

export interface MCPClientBinding {
  client_id: string;
  label: string | null;
  profile_id: string | null;
  default_engine: string | null;
  default_personality: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MCPClientBindingUpsert {
  client_id: string;
  label?: string | null;
  profile_id?: string | null;
  default_engine?: string | null;
  default_personality?: boolean;
}

export interface MCPClientBindingListResponse {
  items: MCPClientBinding[];
}
