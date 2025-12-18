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
export interface FingeringAnchorRef {
  noteId: string;     // matches NoteAnchor.id in ScoreViewer
  dxRel: number;      // offset from note center X in units of note height
  dyRel: number;      // offset from note center Y in units of note height
  baseNoteH?: number; // notehead height at creation time, in px
}

// Staff-anchored text:
// - xRel: relative to measure box
// - y is anchored to treble/bass/between using staff-line glyphs (vf-measure)
// - dyRel is in "staff spaces" (distance between adjacent staff lines)
export type TextAnchorMode = "treble" | "bass" | "between";

export interface TextAnchorRef {
  mode: TextAnchorMode;
  xRel: number;  // Horizontal position within the measure box (0..1)
  dyRel: number;  // Vertical offset from the reference line(s), in staff-space units.
  baseStaffSpacePx: number;  // Creation-time staff-space in px for scaling.
  betweenT?: number;  // Only for mode="between": blend factor between trebleMidY and bassMidY.  0 = treble midline, 1 = bass midline, 0.5 = centered.
}

export interface PedalAnchorRef {
  noteId: string;     // matches NoteAnchor.id in ScoreViewer
  dxRel: number;      // offset from note center X in units of note height
}

// One text mark inside a measure, always anchored to a note.
export interface AnnotationFingeringItem {
  kind: "fingering";
  text: string;
  style?: string;
  anchor: FingeringAnchorRef;  // required now: always note-anchored
}

// Staff text: staff-anchored text (e.g., "rit.", "dolce", etc.)
export interface AnnotationTextItem {
  kind: "text";
  text: string;
  style?: string;
  anchor: TextAnchorRef;
}

// One pedal run "segment" for a measure.
// - left/right: uptick anchors in this measure (if present)
// - active: this measure is part of the continuous pedal run
export interface AnnotationPedalItem {
  kind: "pedal";
  left?: PedalAnchorRef;
  right?: PedalAnchorRef;
  active?: boolean;
  order?: number;
}

// Union of all annotation items.
export type AnnotationItem = AnnotationFingeringItem | AnnotationTextItem | AnnotationPedalItem;

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

interface SaveAnnotationsRequestBody {
  // NOTE: userId removed. Server infers user from auth cookies.
  songId: number;
  measureNumber: MeasureNumber;
  annotations: AnnotationPayload;
}

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

type WhoAmIResponse = {
  ok: boolean;
  userId: number | null;
  // other fields ignored
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

  // True if /api/whoami reports a logged-in user.
  isAuthenticated: boolean;

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

  // Save a batch of measures with ONE optimistic state merge (prevents applyPage N-times).
  saveAnnotationsForMeasures: (
    updates: Record<MeasureNumber, AnnotationPayload>
  ) => Promise<void>;

  // Called by the Edit button to ensure the parent `user_song` row exists
  // for the current user + song (via POST /api/user-song → user_song_upsert).
  ensureUserSongRow: () => Promise<void>;
}

const AnnotationsContext = createContext<AnnotationsContextValue | null>(null);

interface AnnotationsProviderProps {
  songId: number; // matches p_song_id int
  children: ReactNode;
}

// =========================
// Provider
// =========================

// Top-level provider for all annotations of a given song.
// Usage (after ViewerClient cleanup):
//   <AnnotationsProvider songId={songId}>
//     <ScoreViewer src={src} />
//   </AnnotationsProvider>
export function AnnotationsProvider({
  songId,
  children,
}: AnnotationsProviderProps): ReactElement {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasUserSongRow, setHasUserSongRow] = useState<boolean>(false);
  const [annotationsByMeasure, setAnnotationsByMeasure] =
    useState<AnnotationMap>({});

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  // Step 1: Check whether user is logged in via /api/whoami
  useEffect(() => {
    let isCancelled = false;

    async function loadAuthStatus(): Promise<void> {
      try {
        const res = await fetch("/api/whoami", {
          credentials: "include",
          cache: "no-store",
        });

        if (!res.ok) {
          if (!isCancelled) {
            setIsAuthenticated(false);
          }
          return;
        }

        const json = (await res.json()) as WhoAmIResponse;
        if (!isCancelled) {
          setIsAuthenticated(json.userId !== null);
        }
      } catch {
        if (!isCancelled) {
          // Treat network errors as "not authenticated" for now.
          setIsAuthenticated(false);
        }
      }
    }

    void loadAuthStatus();

    return () => {
      isCancelled = true;
    };
  }, []);

  // Step 2: Load annotations if authenticated.
  useEffect(() => {
    let isCancelled = false;

    async function loadAllAnnotations(): Promise<void> {
      setIsLoading(true);
      setErrorMessage(null);

      if (!isAuthenticated) {
        // Not logged in → read-only view, no annotations.
        if (!isCancelled) {
          setHasUserSongRow(false);
          setAnnotationsByMeasure({});
          setIsLoading(false);
        }
        return;
      }

      try {
        const response = await fetch("/api/user-song-measure", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            // NOTE: userId omitted; server derives from cookies.
            songId,
          }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            // Lost auth or not logged in after all.
            if (!isCancelled) {
              setIsAuthenticated(false);
              setHasUserSongRow(false);
              setAnnotationsByMeasure({});
            }
            return;
          }

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
          setErrorMessage("Could not load annotations for this piece.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    // Only attempt to load once we know auth status (initial default false
    // already produces "read-only" behavior, but this keeps semantics clear).
    void loadAllAnnotations();

    return () => {
      isCancelled = true;
    };
  }, [songId, isAuthenticated]);

  const getAnnotationsForMeasure = useCallback(
    (measureNumber: MeasureNumber): AnnotationPayload | undefined => {
      return annotationsByMeasure[measureNumber];
    },
    [annotationsByMeasure]
  );

  // Ensure a user_song row exists for the current user & song.
  // This is called from the Edit button, not during initial load.
  const ensureUserSongRow = useCallback(async (): Promise<void> => {
    if (hasUserSongRow) {
      return;
    }

    if (!songId) {
      console.warn("ensureUserSongRow: no songId; ignoring");
      return;
    }

    if (!isAuthenticated) {
      setErrorMessage("You must be signed in to edit annotations.");
      return;
    }

    try {
      const response = await fetch("/api/user-song", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ songId }), // user inferred on server
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
  }, [hasUserSongRow, isAuthenticated, songId]);

  // Save handler: optimistic local update + PUT /api/user-song-measure.
  const saveAnnotationsForMeasure = useCallback(
    async (
      measureNumber: MeasureNumber,
      payload: AnnotationPayload
    ): Promise<void> => {
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
      if (!isAuthenticated) {
        setErrorMessage("You must be signed in to edit annotations.");
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
          songId,
          measureNumber,
          annotations: payload,
        };

        const response = await fetch("/api/user-song-measure", {
          method: "PUT",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          if (response.status === 401) {
            setIsAuthenticated(false);
            setErrorMessage("You must be signed in to edit annotations.");
            return;
          }

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
    [isAuthenticated, songId]
  );

  const saveAnnotationsForMeasures = useCallback(
    async (updates: Record<MeasureNumber, AnnotationPayload>): Promise<void> => {
      if (!songId) {
        console.warn("saveAnnotationsForMeasures: no songId; ignoring");
        return;
      }
      if (!isAuthenticated) {
        setErrorMessage("You must be signed in to edit annotations.");
        return;
      }

      const measureNumbers = Object.keys(updates)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (measureNumbers.length === 0) {
        return;
      }

      // ONE optimistic merge for all measures.
      setAnnotationsByMeasure((prev: AnnotationMap) => ({
        ...prev,
        ...updates,
      }));

      setIsSaving(true);
      setErrorMessage(null);

      try {
        await Promise.all(
          measureNumbers.map(async (measureNumber) => {
            const payload = updates[measureNumber]!;
            const body: SaveAnnotationsRequestBody = {
              songId,
              measureNumber,
              annotations: payload,
            };

            const response = await fetch("/api/user-song-measure", {
              method: "PUT",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              if (response.status === 401) {
                setIsAuthenticated(false);
                setErrorMessage("You must be signed in to edit annotations.");
                return;
              }

              const text = await response.text();
              console.error(
                "saveAnnotationsForMeasures: HTTP error",
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
              console.error(
                "saveAnnotationsForMeasures: API error",
                data.error
              );
              setErrorMessage(
                data.error ??
                "Unable to save annotations; they may not persist after reload."
              );
            }
          })
        );
      } catch (err) {
        console.error("saveAnnotationsForMeasures: network error", err);
        setErrorMessage("Network error while saving annotations.");
      } finally {
        setIsSaving(false);
      }
    },
    [isAuthenticated, songId]
  );


  const contextValue: AnnotationsContextValue = useMemo(
    () => ({
      isLoading,
      isSaving,
      errorMessage,
      hasUserSongRow,
      isAuthenticated,
      annotationsByMeasure,
      getAnnotationsForMeasure,
      saveAnnotationsForMeasure,
      saveAnnotationsForMeasures,
      ensureUserSongRow,
    }),
    [
      annotationsByMeasure,
      errorMessage,
      getAnnotationsForMeasure,
      hasUserSongRow,
      isAuthenticated,
      isLoading,
      isSaving,
      saveAnnotationsForMeasure,
      saveAnnotationsForMeasures,
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
