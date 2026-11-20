// src/components/LiveIntakeControl.tsx
//
// The "Live dictation" card on the vet's Basic Examination page.
// The vet clicks Start, talks through the exam, and the form boxes fill in.

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Mic, Square } from "lucide-react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  applyLiveIntakeUpdate,
  LIVE_INTAKE_FIELD_LABELS,
} from "@/lib/liveIntakeFields";
import {
  startLiveIntake,
  type LiveIntakeHandle,
  type LiveIntakeStatus,
} from "@/services/LiveIntakeService";
import type { BasicExaminationForm } from "@/services/MedicalRecordService";

type LiveIntakeControlProps = {
  form: BasicExaminationForm;
  onChange: Dispatch<SetStateAction<BasicExaminationForm>>;
  disabled?: boolean;
};

const STATUS_TEXT: Record<LiveIntakeStatus, string> = {
  connecting: "Connecting…",
  listening: "Listening. Speak your findings.",
  reconnecting: "Reconnecting…",
  stopped: "Not listening.",
};

const MAX_CAPTION_LENGTH = 300;

export function LiveIntakeControl({
  form,
  onChange,
  disabled = false,
}: LiveIntakeControlProps) {
  const [status, setStatus] = useState<LiveIntakeStatus>("stopped");
  const [captions, setCaptions] = useState("");
  const [lastFilled, setLastFilled] = useState<string | null>(null);
  const handleRef = useRef<LiveIntakeHandle | null>(null);
  const formRef = useRef(form);
  const isMountedRef = useRef(true);

  // Keep a pointer to the newest form so the service can read it on reconnect.
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  // Turn the microphone off if the vet leaves the page.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  const isActive = status !== "stopped";

  async function handleStart() {
    if (isActive) return;
    setCaptions("");
    setLastFilled(null);
    setStatus("connecting");

    try {
      const handle = await startLiveIntake({
        getForm: () => formRef.current,
        onUpdate: (update) => {
          onChange((current) => applyLiveIntakeUpdate(current, update));
          setLastFilled(
            `${LIVE_INTAKE_FIELD_LABELS[update.field]}: ${update.value}`,
          );
        },
        onTranscript: (text) =>
          setCaptions((current) =>
            (current + text).slice(-MAX_CAPTION_LENGTH),
          ),
        onStatus: setStatus,
        onError: (message) => toast.error(message),
      });

      if (!isMountedRef.current) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
    } catch (error) {
      console.error("Unable to start live dictation:", error);
      setStatus("stopped");
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to start live dictation right now.",
      );
    }
  }

  function handleStop() {
    handleRef.current?.stop();
    handleRef.current = null;
    setStatus("stopped");
  }

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Mic aria-hidden="true" className="size-5 text-primary" />
          Live dictation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {status === "listening" || status === "reconnecting" ? (
            <Button onClick={handleStop} type="button" variant="destructive">
              <Square aria-hidden="true" />
              Stop listening
            </Button>
          ) : (
            <Button
              disabled={disabled || status === "connecting"}
              onClick={() => {
                void handleStart();
              }}
              type="button"
            >
              <Mic aria-hidden="true" />
              {status === "connecting" ? "Connecting…" : "Start listening"}
            </Button>
          )}
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {STATUS_TEXT[status]}
          </p>
        </div>

        {lastFilled ? (
          <p className="text-sm text-foreground">
            <span className="font-medium">Last filled:</span> {lastFilled}
          </p>
        ) : null}

        {captions ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-sm italic text-muted-foreground">
            Heard: {captions}
          </p>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Speak findings out loud, for example “weight is 128 grams” or “coat
          looks dull”. Check every box before you save. Nothing is saved until
          you submit the form.
        </p>
      </CardContent>
    </Card>
  );
}
