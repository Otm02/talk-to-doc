"use client";

import { useRef, useState } from "react";
import { DocumentCard } from "@/features/document/document-card";
import { ReadyBar } from "@/features/document/ready-bar";
import { TextPreview } from "@/features/document/text-preview";
import { ErrorCard } from "./error-card";
import type { RecoveryAction } from "./error-copy";
import { PdfPicker } from "./pdf-picker";
import { SAMPLE_PDF, SAMPLE_VIDEO_URL, SampleChips } from "./sample-chips";
import { SourceSwitch, type Source } from "./source-switch";
import { UploadStatus } from "./upload-status";
import { useIngest } from "./use-ingest";
import { YoutubeField } from "./youtube-field";

export function IngestScreen() {
  const ingest = useIngest();
  const { state } = ingest;
  const [source, setSource] = useState<Source>("pdf");
  const [lastUrl, setLastUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function startOver(next?: Source) {
    ingest.reset();
    if (next) setSource(next);
  }

  function onErrorAction(action: RecoveryAction) {
    switch (action) {
      case "retry":
        ingest.retry();
        break;
      case "pick-another-file":
        startOver("pdf");
        // The input mounts after the reset renders.
        setTimeout(() => fileInputRef.current?.click(), 0);
        break;
      case "edit-link":
        startOver("youtube");
        break;
      case "try-pdf":
        startOver("pdf");
        break;
      case "reload":
        window.location.reload();
        break;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  const doc =
    state.status === "ready" || state.status === "extracting" ? state.doc : null;

  if (doc) {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <DocumentCard doc={doc} />
        {state.status === "extracting" && (
          <UploadStatus state={state} source={source} onCancel={ingest.cancel} />
        )}
        <TextPreview doc={doc} />
        {state.status === "ready" && (
          <ReadyBar onUseAnother={() => startOver()} voiceDisabled />
        )}
      </div>
    );
  }

  const working = state.status === "uploading" || state.status === "extracting";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Talk to a document</h1>
        <p className="text-sm text-muted-foreground">
          Add a PDF or a YouTube link, then ask about it out loud.
        </p>
      </div>

      <SourceSwitch value={source} onChange={setSource} disabled={working} />

      {working ? (
        <UploadStatus state={state} source={source} onCancel={ingest.cancel} />
      ) : source === "pdf" ? (
        <PdfPicker
          inputRef={fileInputRef}
          onFile={(file) => void ingest.startPdf(file)}
        />
      ) : (
        <YoutubeField
          initialValue={lastUrl}
          onSubmit={(url) => {
            setLastUrl(url);
            void ingest.startYoutube(url);
          }}
        />
      )}

      {state.status === "error" && (
        <ErrorCard
          code={state.code}
          retryAfterSeconds={state.retryAfterSeconds}
          onAction={onErrorAction}
        />
      )}

      <SampleChips
        disabled={working}
        onPdf={() => {
          setSource("pdf");
          void ingest.startSamplePdf(SAMPLE_PDF.url, SAMPLE_PDF.name);
        }}
        onVideo={() => {
          setSource("youtube");
          setLastUrl(SAMPLE_VIDEO_URL);
          void ingest.startYoutube(SAMPLE_VIDEO_URL);
        }}
      />
    </div>
  );
}
