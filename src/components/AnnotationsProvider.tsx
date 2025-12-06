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

// Front-end only shape of a single text annotation item inside a measure.
// This mirrors what ScoreViewer expects in its MeasureAnnotation type.
export interface AnnotationTextItem {
  kind: "text";
  xRel: number;
  yRel: number;
  text: string;
  style?: string;
  anchor?: {
    type: "note";
    noteId: string;
    dxRel: number;
    dyRel: number;
    baseNoteH?: number;
  };
}

export interface AnnotationPedalItem {
  kind: "pedal";
  // relative X inside the measure box: 0 = left edge, 1 = right edge
  startXRel: number;
  endXRel: number;
}

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
  // We can use this in the UI to decide whether to show
  // "Add to My Songs" / enable editing, etc.
  hasUserSongRow: boolean;

  annotationsByMeasure: AnnotationMap;

  // Return undefined when no annotation exists for this measure.
  getAnnotationsForMeasure: (measureNumber: MeasureNumber) => AnnotationPayload | undefined;

  // Save (insert or update) the annotation payload for a single measure.
  // For now this only performs an optimistic local update; the server-side
  // persistence will be wired up via /api/user-song-measure (PUT) later.
  saveAnnotationsForMeasure: (
    measureNumber: MeasureNumber,
    payload: AnnotationPayload
  ) => Promise<void>;
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
  const [annotationsByMeasure, setAnnotationsByMeasure] = useState<AnnotationMap>({});

  // Internal helper: consult /api/user-song to see whether a user_song row exists
  // for (userId, songId). For now, this does NOT create the row if it is missing;
  // it simply flips hasUserSongRow on if it exists.
  // Later, if we want "ensure row exists" semantics, we can extend the route to
  // insert as needed and keep this helper unchanged.
  const ensureUserSongRow = useCallback(
    async (effectiveUserId: number): Promise<void> => {
      if (hasUserSongRow) {
        return;
      }

      const response = await fetch("/api/user-song", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: effectiveUserId,
          songId,
        }),
      });

      if (!response.ok) {
        // We treat this as a soft failure: log it, but don't block rendering.
        console.error("user-song API error, status:", response.status);
        return;
      }

      const json = (await response.json()) as UserSongApiResponse;

      if (json.ok && json.data) {
        setHasUserSongRow(true);
      } else {
        // No row yet is not a hard error; we just leave hasUserSongRow as false.
        // This is the expected state the first time a user visits a song.
      }
    },
    [hasUserSongRow, songId]
  );

  // Initial load:
  //   - If no user → just mark as not loading; annotations remain empty.
  //   - If user exists:
  //       1. Check for user_song row via /api/user-song.
  //       2. Load all measure annotations via /api/user-song-measure.
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
        await ensureUserSongRow(userId);

        if (isCancelled) {
          return;
        }

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
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          console.error("Failed to load annotations via API", err);
          // Important: "no annotations yet" → we treat as empty, NOT an error.
          // We only set errorMessage for real API/parse failures.
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
  }, [ensureUserSongRow, songId, userId]);

  const getAnnotationsForMeasure = useCallback(
    (measureNumber: MeasureNumber): AnnotationPayload | undefined => {
      // If this measure has no entry, this will just be `undefined`,
      // which matches the context type.
      return annotationsByMeasure[measureNumber];
    },
    [annotationsByMeasure]
  );

  // Save handler: for now, only performs an optimistic local update.
  // We will wire this to a PUT /api/user-song-measure endpoint (calling
  // user_song_measure_update / user_song_measure_insert) in a later step.
  const saveAnnotationsForMeasure = useCallback(
    async (measureNumber: MeasureNumber, payload: AnnotationPayload): Promise<void> => {
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
        console.warn("saveAnnotationsForMeasure: invalid measureNumber", measureNumber);
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
          console.error("saveAnnotationsForMeasure: HTTP error", response.status, text);
          setErrorMessage("Unable to save annotations; they may not persist after reload.");
          return;
        }

        // Narrow the JSON to our expected shape
        const data = (await response.json()) as SaveAnnotationsResponseBody;

        if (!data.ok) {
          console.error("saveAnnotationsForMeasure: API error", data.error);
          setErrorMessage(
            data.error ?? "Unable to save annotations; they may not persist after reload.",
          );
          return;
        }

        // Success: nothing else to do; optimistic state already matches.
      } catch (err) {
        console.error("saveAnnotationsForMeasure: network or parsing error", err);
        setErrorMessage("Network error while saving annotations.");
      } finally {
        setIsSaving(false);
      }
    },
    [userId, songId, setAnnotationsByMeasure],
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
    }),
    [
      annotationsByMeasure,
      errorMessage,
      getAnnotationsForMeasure,
      hasUserSongRow,
      isLoading,
      isSaving,
      saveAnnotationsForMeasure,
    ]
  );

  return (
    <AnnotationsContext.Provider value={contextValue}>
      {children}
    </AnnotationsContext.Provider>
  );
}

// Hook for consuming annotations inside the score viewer / overlays.
// Example usage (later, inside ScoreViewer or a child):
//   const { getAnnotationsForMeasure, saveAnnotationsForMeasure } = useAnnotations();
export function useAnnotations(): AnnotationsContextValue {
  const context = useContext(AnnotationsContext);
  if (!context) {
    throw new Error("useAnnotations must be used within an AnnotationsProvider");
  }
  return context;
}
