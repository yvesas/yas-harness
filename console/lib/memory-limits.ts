// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Here rather than beside the actions, because a `'use server'` file may export
 * only async functions — a constant in one is a build error, and the message is
 * about collecting configuration rather than about the constant.
 */

/**
 * How many resources one ingest run takes from a connection.
 *
 * A cap rather than everything: a connected Drive can hold tens of thousands of
 * files and the person who clicked is watching a page. Stated on screen when it
 * is reached, because a truncated import that looks complete is worse than one
 * that says it stopped.
 */
export const INGEST_LIMIT = 50;
