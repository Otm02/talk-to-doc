"use client";

import { useEffect, useRef, useState } from "react";
import { DocumentCard } from "@/features/document/document-card";
import { TextPreview } from "@/features/document/text-preview";
import { VoiceChat } from "@/features/voice/ui/voice-chat";
import { ErrorCard } from "./error-card";
import type { RecoveryAction } from "./error-copy";
import { PartialNotice } from "./partial-notice";
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  // "Use another source" removes the button that was just tapped, and focus
  // would fall to <body>. It is put on the screen's heading instead.
  const refocusRef = useRef(false);

  function startOver(next?: Source) {
    ingest.reset();
    if (next) setSource(next);
  }

  function useAnotherSource() {
    refocusRef.current = true;
    startOver();
  }

  // An error belongs to the tab it happened on: a PDF's "not a PDF" under the
  // YouTube field, or the other way round, is about something that is gone.
  function changeSource(next: Source) {
    if (next === source) return;
    setSource(next);
    if (state.status === "error") ingest.reset();
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
    state.status === "ready" ||
    state.status === "extracting" ||
    state.status === "partial"
      ? state.doc
      : null;

  useEffect(() => {
    if (refocusRef.current && !doc) {
      refocusRef.current = false;
      headingRef.current?.focus();
    }
  });

  if (doc) {
    const view = (
      <div className="flex flex-1 flex-col gap-4">
        <DocumentCard doc={doc} interrupted={state.status === "partial"} />
        {state.status === "extracting" && (
          <UploadStatus
            state={state}
            source={source}
            onCancel={ingest.cancel}
          />
        )}
        {state.status === "partial" && (
          <PartialNotice
            doc={doc}
            onRetry={ingest.retry}
            onStartOver={() => startOver()}
          />
        )}
        <TextPreview doc={doc} />
      </div>
    );
    if (state.status !== "ready") return view;
    return (
      <VoiceChat
        doc={doc}
        onUseAnother={useAnotherSource}
        // The file or link is still in memory: loading it again is one tap.
        onReloadSource={ingest.retry}
      >
        {view}
      </VoiceChat>
    );
  }

  const working = state.status === "uploading" || state.status === "extracting";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold outline-none"
        >
          Talk to a document
        </h1>
        <p className="text-sm text-muted-foreground">
          Add a PDF or a YouTube link, then ask about it out loud.
        </p>
      </div>

      <SourceSwitch value={source} onChange={changeSource} disabled={working} />

      {working ? (
        <UploadStatus
          state={state}
          source={source}
          onCancel={ingest.cancel}
          onKeepWaiting={ingest.keepWaiting}
        />
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
          retryAt={state.retryAt}
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
