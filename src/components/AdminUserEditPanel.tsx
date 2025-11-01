"use client";
import React from "react";
import styles from "./AdminUserEditPanel.module.css";

type Role = { number: number; name: string };

type Props = {
    userName: string;
    userEmail: string;
    userFirst: string;
    userLast: string;
    roleNumber: string;
    roles: ReadonlyArray<Role>;
    rolesLoading: boolean;
    rolesError: string;
    errorText: string;
    saveOkText: string;
    statusTick: number;
    canSave: boolean;
    saveLabel: string;
    canDelete: boolean;
    deleting: boolean;
    onChangeUserName(value: string): void;
    onChangeUserEmail(value: string): void;
    onChangeUserFirst(value: string): void;
    onChangeUserLast(value: string): void;
    onChangeRoleNumber(value: string): void;
    onPick(): void;
    onSave(): void;
    onDelete(): void;
    isDark: boolean;
};

export default function AdminUserEditPanel(props: Props): React.ReactElement {
    const {
        userName, userEmail, userFirst, userLast,
        roleNumber, roles, rolesLoading, rolesError,
        errorText, saveOkText, statusTick,
        canSave, saveLabel, canDelete, deleting,
        onChangeUserName, onChangeUserEmail, onChangeUserFirst, onChangeUserLast,
        onChangeRoleNumber, onPick, onSave, onDelete, isDark,
    } = props;

    const rolesDisabled = rolesLoading || !!rolesError || roles.length === 0;

    return (
        <section aria-label="Edit panel" className={styles.panelSection} data-theme={isDark ? "dark" : "light"}>
            <div className={styles.panel}>
                <div className={styles.grid}>
                    <label className={styles.label} htmlFor="user-name">Username</label>
                    <input
                        id="user-name"
                        className={styles.input}
                        type="text"
                        value={userName}
                        onChange={(e) => onChangeUserName(e.target.value)}
                        aria-label="Username"
                        autoComplete="off"
                        data-lpignore="true"
                        data-form-type="other"
                    />

                    <label className={styles.label} htmlFor="user-email">Email</label>
                    <input
                        id="user-email"
                        className={styles.input}
                        type="email"
                        value={userEmail}
                        onChange={(e) => onChangeUserEmail(e.target.value)}
                        aria-label="Email"
                        autoComplete="off"
                        data-lpignore="true"
                        data-form-type="other"
                    />

                    <label className={styles.label} htmlFor="user-name-first">Name</label>
                    <div className={styles.nameRow}>
                        <input
                            id="user-name-first"
                            className={styles.input}
                            type="text"
                            value={userFirst}
                            onChange={(e) => onChangeUserFirst(e.target.value)}
                            placeholder="First"
                            aria-label="First name"
                            autoComplete="off"
                            data-lpignore="true"
                            data-form-type="other"
                        />
                        <input
                            id="user-name-last"
                            className={styles.input}
                            type="text"
                            value={userLast}
                            onChange={(e) => onChangeUserLast(e.target.value)}
                            placeholder="Last"
                            aria-label="Last name"
                            autoComplete="off"
                            data-lpignore="true"
                            data-form-type="other"
                        />
                    </div>

                    <label className={styles.label} htmlFor="user-role">Role</label>
                    <select
                        id="user-role"
                        className={styles.select}
                        value={roleNumber}
                        onChange={(e) => onChangeRoleNumber(e.target.value)}
                        disabled={rolesDisabled}
                        aria-disabled={rolesDisabled}
                        aria-busy={rolesLoading || undefined}
                    >
                        <option value="" disabled>-- Select a role --</option>
                        {roles.map((role) => (
                            <option key={role.number} value={String(role.number)}>
                                {role.name}
                            </option>
                        ))}
                    </select>

                    {rolesError ? (
                        <div className={`${styles.statusArea} ${styles.error}`} role="alert" aria-live="assertive" style={{ gridColumn: "1 / span 2" }}>
                            Failed to load roles: {rolesError}
                        </div>
                    ) : null}
                </div>

                <div className={styles.actions}>
                    <div className={styles.leftActions}>
                        <button type="button" onClick={onPick} className={styles.secondary} aria-label="Clear selection">
                            Clear
                        </button>
                    </div>

                    <div className={styles.statusWrap}>
                        <span
                            key={`status-${statusTick}`}
                            className={`${styles.statusArea} ${errorText ? styles.error : saveOkText ? styles.ok : ""}`}
                            role={errorText ? "alert" : saveOkText ? "status" : undefined}
                            aria-live={errorText ? "assertive" : saveOkText ? "polite" : "off"}
                            title={errorText || saveOkText || ""}
                        >
                            {errorText || saveOkText || ""}
                        </span>
                    </div>

                    <div className={styles.rightActions}>
                        <button type="button" onClick={onSave} className={styles.primary} disabled={!canSave} aria-disabled={!canSave}>
                            {saveLabel}
                        </button>
                        <button
                            type="button"
                            onClick={onDelete}
                            className={styles.danger}
                            disabled={!canDelete}
                            aria-disabled={!canDelete}
                            title={canDelete ? "Delete this user permanently" : "Delete unavailable"}
                        >
                            {deleting ? "Deleting..." : "Delete User"}
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
}
