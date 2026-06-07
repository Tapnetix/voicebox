import { zodResolver } from '@hookform/resolvers/zod';
import { Mic, Monitor, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { AudioTrimmer } from '@/components/AudioTrimmer/AudioTrimmer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormField,
} from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/use-toast';
import { useAudioPlayer } from '@/lib/hooks/useAudioPlayer';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { useAddSample, useProfile } from '@/lib/hooks/useProfiles';
import type { LanguageCode } from '@/lib/constants/languages';
import { useReferenceTranscript } from '@/lib/hooks/useReferenceTranscript';
import { useSystemAudioCapture } from '@/lib/hooks/useSystemAudioCapture';
import { usePlatform } from '@/platform/PlatformContext';
import { AudioSampleRecording } from './AudioSampleRecording';
import { AudioSampleSystem } from './AudioSampleSystem';
import { AudioSampleUpload } from './AudioSampleUpload';
import { ReferenceTranscript } from './ReferenceTranscript';

const sampleSchema = z.object({
  file: z.instanceof(File, { message: 'Please select an audio file' }),
  referenceText: z
    .string()
    .min(1, 'Reference text is required')
    .max(1000, 'Reference text must be less than 1000 characters'),
});

type SampleFormValues = z.infer<typeof sampleSchema>;

interface SampleUploadProps {
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SampleUpload({ profileId, open, onOpenChange }: SampleUploadProps) {
  const platform = usePlatform();
  const addSample = useAddSample();
  const { data: profile } = useProfile(profileId);
  const { toast } = useToast();
  const [mode, setMode] = useState<'upload' | 'record' | 'system'>('upload');
  const { isPlaying, playPause, cleanup: cleanupAudio } = useAudioPlayer();

  // rawFile: the file selected/recorded — fed into AudioTrimmer as input only
  // The form's 'file' field holds the trimmed file returned by AudioTrimmer.onConfirm
  const [rawFile, setRawFile] = useState<File | null>(null);

  const form = useForm<SampleFormValues>({
    resolver: zodResolver(sampleSchema),
    defaultValues: {
      referenceText: '',
    },
  });

  const confirmedFile = form.watch('file');
  const referenceText = form.watch('referenceText') ?? '';
  const transcript = useReferenceTranscript({
    file: confirmedFile ?? null,
    text: referenceText,
    setText: (v) => form.setValue('referenceText', v, { shouldValidate: true }),
    language: profile?.language as LanguageCode | undefined,
  });

  const {
    isRecording,
    duration,
    error: recordingError,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    maxDurationSeconds: 120,
    onRecordingComplete: (blob, recordedDuration) => {
      // Convert blob to File object
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      // Feed recorded file into the trimmer; form 'file' will be set on trimmer confirm
      setRawFile(file);
      toast({
        title: 'Recording complete',
        description: 'Audio has been recorded successfully.',
      });
    },
  });

  const {
    isRecording: isSystemRecording,
    duration: systemDuration,
    error: systemRecordingError,
    isSupported: isSystemAudioSupported,
    startRecording: startSystemRecording,
    stopRecording: stopSystemRecording,
    cancelRecording: cancelSystemRecording,
  } = useSystemAudioCapture({
    maxDurationSeconds: 120,
    onRecordingComplete: (blob, recordedDuration) => {
      // Convert blob to File object
      const file = new File([blob], `system-audio-${Date.now()}.wav`, {
        type: blob.type || 'audio/wav',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      // Feed captured file into the trimmer; form 'file' will be set on trimmer confirm
      setRawFile(file);
      toast({
        title: 'System audio captured',
        description: 'Audio has been captured successfully.',
      });
    },
  });

  // Show recording errors
  useEffect(() => {
    if (recordingError) {
      toast({
        title: 'Recording error',
        description: recordingError,
        variant: 'destructive',
      });
    }
  }, [recordingError, toast]);

  // Show system audio recording errors
  useEffect(() => {
    if (systemRecordingError) {
      toast({
        title: 'System audio capture error',
        description: systemRecordingError,
        variant: 'destructive',
      });
    }
  }, [systemRecordingError, toast]);

  async function onSubmit(data: SampleFormValues) {
    try {
      await addSample.mutateAsync({
        profileId,
        file: data.file,
        referenceText: data.referenceText,
      });

      toast({
        title: 'Sample added',
        description: 'Audio sample has been added successfully.',
      });

      handleOpenChange(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add sample',
        variant: 'destructive',
      });
    }
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      form.reset();
      setRawFile(null);
      setMode('upload');
      if (isRecording) {
        cancelRecording();
      }
      if (isSystemRecording) {
        cancelSystemRecording();
      }
      cleanupAudio();
    }
    onOpenChange(newOpen);
  }

  function handleCancelRecording() {
    if (mode === 'record') {
      cancelRecording();
    } else if (mode === 'system') {
      cancelSystemRecording();
    }
    setRawFile(null);
    form.resetField('file');
    cleanupAudio();
  }

  function handleTrimmerConfirm(trimmed: File, _durationSec: number) {
    form.setValue('file', trimmed, { shouldValidate: true });
  }

  function handlePlayPause() {
    const file = form.getValues('file');
    playPause(file);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Audio Sample</DialogTitle>
          <DialogDescription>
            Upload an audio file and provide the reference text that matches the audio.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'upload' | 'record' | 'system')}>
              <TabsList
                className={`grid w-full ${platform.metadata.isTauri && isSystemAudioSupported ? 'grid-cols-3' : 'grid-cols-2'}`}
              >
                <TabsTrigger value="upload" className="flex items-center gap-2">
                  <Upload className="h-4 w-4 shrink-0" />
                  Upload
                </TabsTrigger>
                <TabsTrigger value="record" className="flex items-center gap-2">
                  <Mic className="h-4 w-4 shrink-0" />
                  Record
                </TabsTrigger>
                {platform.metadata.isTauri && isSystemAudioSupported && (
                  <TabsTrigger value="system" className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 shrink-0" />
                    System Audio
                  </TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="upload" className="space-y-4">
                <FormField
                  control={form.control}
                  name="file"
                  render={({ field: { name } }) => (
                    <AudioSampleUpload
                      file={rawFile}
                      onFileChange={(f) => {
                        // Feed into trimmer; do NOT set form value here
                        setRawFile(f ?? null);
                        if (!f) {
                          form.resetField('file');
                        }
                      }}
                      onPlayPause={handlePlayPause}
                      isPlaying={isPlaying}
                      fieldName={name}
                    />
                  )}
                />
                {rawFile && (
                  <AudioTrimmer
                    file={rawFile}
                    onConfirm={handleTrimmerConfirm}
                  />
                )}
              </TabsContent>

              <TabsContent value="record" className="space-y-4">
                <FormField
                  control={form.control}
                  name="file"
                  render={() => (
                    <AudioSampleRecording
                      file={rawFile}
                      isRecording={isRecording}
                      duration={duration}
                      onStart={startRecording}
                      onStop={stopRecording}
                      onCancel={handleCancelRecording}
                      onPlayPause={handlePlayPause}
                      isPlaying={isPlaying}
                    />
                  )}
                />
                {rawFile && !isRecording && (
                  <AudioTrimmer
                    file={rawFile}
                    onConfirm={handleTrimmerConfirm}
                  />
                )}
              </TabsContent>

              {platform.metadata.isTauri && isSystemAudioSupported && (
                <TabsContent value="system" className="space-y-4">
                  <FormField
                    control={form.control}
                    name="file"
                    render={() => (
                      <AudioSampleSystem
                        file={rawFile}
                        isRecording={isSystemRecording}
                        duration={systemDuration}
                        onStart={startSystemRecording}
                        onStop={stopSystemRecording}
                        onCancel={handleCancelRecording}
                        onPlayPause={handlePlayPause}
                        isPlaying={isPlaying}
                      />
                    )}
                  />
                  {rawFile && !isSystemRecording && (
                    <AudioTrimmer
                      file={rawFile}
                      onConfirm={handleTrimmerConfirm}
                    />
                  )}
                </TabsContent>
              )}
            </Tabs>

            <ReferenceTranscript
              value={referenceText}
              onChange={(v) => form.setValue('referenceText', v, { shouldValidate: true })}
              status={transcript.status}
              isTranscribing={transcript.isTranscribing}
              regeneratePrompt={transcript.regeneratePrompt}
              onRetranscribe={transcript.retranscribe}
              onAcceptRegenerate={transcript.acceptRegenerate}
              onKeepEdits={transcript.keepEdits}
              hasClip={!!confirmedFile}
            />

            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addSample.isPending}>
                {addSample.isPending ? 'Uploading...' : 'Add Sample'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
