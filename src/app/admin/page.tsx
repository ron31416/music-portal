// src/app/admin/page.tsx
"use client";

import React from "react";
import styles from "./page.module.css";

export default function AdminHubPage(): React.ReactElement {
  const goSongs = (): void => {
    window.open("/admin/songs", "_blank", "noopener,noreferrer");
  };

  const goUsers = (): void => {
    window.open("/admin/users", "_blank", "noopener,noreferrer");
  };

  return (
    <main id="admin-hub" className={styles.hub}>
      <button id="hub-songs-btn" type="button" className={styles.hubButton} onClick={goSongs}>
        Songs
      </button>

      <button id="hub-users-btn" type="button" className={styles.hubButton} onClick={goUsers}>
        Users
      </button>
    </main>
  );
}
