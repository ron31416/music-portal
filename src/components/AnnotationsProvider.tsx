// src/components/AnnotationsProvider.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
  ReactElement,
} from "react";

// ---- Shared annotation types (note-anchored) -----------------------------

// Note-relative anchor:
//   dxRel, dyRel are offsets expressed in units of notehead height.
export interface NoteAnchorRef {
  type: "note";
  noteId: string;   // matches NoteAnchor.id in ScoreViewer
  dxRel: number;    // offset from note center X in units of note height
  dyRel: number;    // offset from note center Y in units of note height
  baseNoteH?: number; // notehead height at creation time, in px
}

// One text mark inside a measure, always anchored to a note.
export interface AnnotationTextItem {
  kind: "text";
  text: string;
  style?: string;
  anchor: NoteAnchorRef;  // required now: always note-anchored
}

// One pedal run "segment" for a measure.
// - left/right: uptick anchors in this measure (if present)
// - active: this measure is part of the continuous pedal run
export interface AnnotationPedalItem {
  kind: "pedal";
  left?: NoteAnchorRef;
  right?: NoteAnchorRef;
  active?: boolean;
}

// Union of all annotation items.
export type AnnotationItem = AnnotationTextItem | AnnotationPedalItem;

// Front-end only shape of the annotation payload.
// The DB just stores this as `jsonb`.
export interface AnnotationPayload {
  // Optional list of text items for this measure
  items?: AnnotationItem[];
  // Other fields you may add later (boxes, fingerings, etc.)
  boxes?: unknown[];
  fingerings?: unknown[];
  text?: unknown[];

  // Index signature so this is assignable to MeasureAnnotation
  [key: string]: unknown;
}

export type MeasureNumber = number;

export type AnnotationMap = Record<MeasureNumber, AnnotationPayload>;

// =========================
// API response types
// =========================

// Request body for saving annotations for a single measure
interface SaveAnnotationsRequestBody {
  userId: number;
  songId: number;
  measureNumber: MeasureNumber;
  annotations: AnnotationPayload;
}

// Minimal response we expect back from the API route
interface SaveAnnotationsResponseBody {
  ok: boolean;
  error?: string;
}

type UserSongApiResponse = {
  ok: boolean;
  data:
  | {
    user_song_id: number;
    user_id: number;
    song_id: number;
    inserted_datetime: string | null;
    updated_datetime: string | null;
  }
  | null;
  error?: string;
  message?: string;
};

type UserSongMeasureRow = {
  measure_number: number;
  annotations_json: AnnotationPayload | null;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

type UserSongMeasureApiResponse = {
  ok: boolean;
  data: UserSongMeasureRow[];
  error?: string;
  message?: string;
};

// =========================
// Context types
// =========================

interface AnnotationsContextValue {
  isLoading: boolean;
  isSaving: boolean;
  errorMessage: string | null;

  // True once a `user_song` row exists for (user, song).
  hasUserSongRow: boolean;

  annotationsByMeasure: AnnotationMap;

  // Return undefined when no annotation exists for this measure.
  getAnnotationsForMeasure: (
    measureNumber: MeasureNumber
  ) => AnnotationPayload | undefined;

  // Save (insert or update) the annotation payload for a single measure.
  saveAnnotationsForMeasure: (
    measureNumber: MeasureNumber,
    payload: AnnotationPayload
  ) => Promise<void>;

  // Called by the Edit button to ensure the parent `user_song` row exists
  // for the current user + song (via POST /api/user-song → user_song_upsert).
  ensureUserSongRow: () => Promise<void>;
}

const AnnotationsContext = createContext<AnnotationsContextValue | null>(null);

interface AnnotationsProviderProps {
  songId: number;          // matches p_song_id int
  userId: number | null;   // null/undefined if not logged in
  children: ReactNode;
}

// =========================
// Provider
// =========================

// Top-level provider for all annotations of a given song for a given user.
// Usage (already wired in ViewerClient):
//   <AnnotationsProvider songId={songId} userId={userId}>
//     <ScoreViewer src={src} />
//   </AnnotationsProvider>
export function AnnotationsProvider({
  songId,
  userId,
  children,
}: AnnotationsProviderProps): ReactElement {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasUserSongRow, setHasUserSongRow] = useState<boolean>(false);
  const [annotationsByMeasure, setAnnotationsByMeasure] =
    useState<AnnotationMap>({});

  // Ensure a user_song row exists for the current user & song.
  // This is called from the Edit button, not during initial load.
  const ensureUserSongRow = useCallback(async (): Promise<void> => {
    // If we've already ensured it, nothing to do.
    if (hasUserSongRow) {
      return;
    }

    if (!songId) {
      console.warn("ensureUserSongRow: no songId; ignoring");
      return;
    }

    try {
      const response = await fetch("/api/user-song", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ songId, userId }),
      });

      if (!response.ok) {
        console.error("user-song upsert POST error, status:", response.status);
        setErrorMessage(
          response.status === 401
            ? "You must be signed in to edit annotations."
            : "Unable to prepare this score for annotations."
        );
        return;
      }

      const json = (await response.json()) as UserSongApiResponse;

      if (json.ok && json.data) {
        setHasUserSongRow(true);
      } else {
        console.warn("user-song upsert POST returned no row", json);
        // leave hasUserSongRow as-is
      }
    } catch (e) {
      console.error("ensureUserSongRow: network error", e);
      setErrorMessage("Network error while preparing annotations.");
    }
  }, [hasUserSongRow, songId, userId]);

  // Initial load:
  //   - If no user → just mark as not loading; annotations remain empty.
  //   - If user exists:
  //       1. Load all measure annotations via /api/user-song-measure.
  //       2. If any rows are returned, we know a user_song row exists.
  useEffect(() => {
    let isCancelled = false;

    async function loadAllAnnotations(): Promise<void> {
      setIsLoading(true);
      setErrorMessage(null);

      if (userId === null || userId === undefined) {
        // Not logged in → read-only view, no annotations.
        setHasUserSongRow(false);
        setAnnotationsByMeasure({});
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch("/api/user-song-measure", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId,
            songId,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `user-song-measure API error: ${response.status} ${text}`
          );
        }

        const json = (await response.json()) as UserSongMeasureApiResponse;

        if (!json.ok || !Array.isArray(json.data)) {
          throw new Error(json.message ?? "Invalid annotation list response");
        }

        const rows = json.data;

        const map: AnnotationMap = {};
        for (const row of rows) {
          if (row.annotations_json) {
            map[row.measure_number] = row.annotations_json;
          }
        }

        if (!isCancelled) {
          setAnnotationsByMeasure(map);
          // If we have any measure rows, we know a user_song row exists.
          if (rows.length > 0) {
            setHasUserSongRow(true);
          }
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          console.error("Failed to load annotations via API", err);
          // "No annotations yet" is not an error; but API/parse failures are.
          setErrorMessage("Could not load annotations for this piece.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadAllAnnotations();

    return () => {
      isCancelled = true;
    };
  }, [songId, userId]);

  const getAnnotationsForMeasure = useCallback(
    (measureNumber: MeasureNumber): AnnotationPayload | undefined => {
      return annotationsByMeasure[measureNumber];
    },
    [annotationsByMeasure]
  );

  // Save handler: optimistic local update + PUT /api/user-song-measure.
  const saveAnnotationsForMeasure = useCallback(
    async (
      measureNumber: MeasureNumber,
      payload: AnnotationPayload
    ): Promise<void> => {
      // Require a logged-in user and a valid songId
      if (!userId) {
        console.warn("saveAnnotationsForMeasure: no userId; ignoring");
        return;
      }
      if (!songId) {
        console.warn("saveAnnotationsForMeasure: no songId; ignoring");
        return;
      }
      if (!Number.isFinite(measureNumber) || measureNumber <= 0) {
        console.warn(
          "saveAnnotationsForMeasure: invalid measureNumber",
          measureNumber
        );
        return;
      }

      // Optimistic update: update local state immediately so UI feels snappy.
      setAnnotationsByMeasure((prev) => ({
        ...prev,
        [measureNumber]: payload,
      }));

      setIsSaving(true);
      setErrorMessage(null);

      try {
        const body: SaveAnnotationsRequestBody = {
          userId,
          songId,
          measureNumber,
          annotations: payload,
        };

        const response = await fetch("/api/user-song-measure", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(
            "saveAnnotationsForMeasure: HTTP error",
            response.status,
            text
          );
          setErrorMessage(
            "Unable to save annotations; they may not persist after reload."
          );
          return;
        }

        const data =
          (await response.json()) as SaveAnnotationsResponseBody;

        if (!data.ok) {
          console.error("saveAnnotationsForMeasure: API error", data.error);
          setErrorMessage(
            data.error ??
            "Unable to save annotations; they may not persist after reload."
          );
          return;
        }

        // Success: optimistic state already matches.
      } catch (err) {
        console.error(
          "saveAnnotationsForMeasure: network or parsing error",
          err
        );
        setErrorMessage("Network error while saving annotations.");
      } finally {
        setIsSaving(false);
      }
    },
    [userId, songId]
  );

  const contextValue: AnnotationsContextValue = useMemo(
    () => ({
      isLoading,
      isSaving,
      errorMessage,
      hasUserSongRow,
      annotationsByMeasure,
      getAnnotationsForMeasure,
      saveAnnotationsForMeasure,
      ensureUserSongRow,
    }),
    [
      annotationsByMeasure,
      errorMessage,
      getAnnotationsForMeasure,
      hasUserSongRow,
      isLoading,
      isSaving,
      saveAnnotationsForMeasure,
      ensureUserSongRow,
    ]
  );

  return (
    <AnnotationsContext.Provider value={contextValue}>
      {children}
    </AnnotationsContext.Provider>
  );
}

// Hook for consuming annotations inside the score viewer / overlays.
export function useAnnotations(): AnnotationsContextValue {
  const context = useContext(AnnotationsContext);
  if (!context) {
    throw new Error("useAnnotations must be used within an AnnotationsProvider");
  }
  return context;
}
