"use client";

import { type FormEvent, useEffect, useState } from "react";

import { createPost, fetchFeed, type Post } from "@/lib/api";
import { useMe } from "@/lib/identity";
import { SignInLink } from "./SignIn";

export function Feed() {
  const me = useMe();
  const [feed, setFeed] = useState<Post[] | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  useEffect(() => {
    fetchFeed().then(setFeed);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = (form.elements.namedItem("body") as HTMLTextAreaElement).value
      .trim();
    if (!body || posting) return;
    setPostError(null);
    setPosting(true);
    try {
      const created = await createPost(body);
      form.reset();
      // Optimistic: prepend the new post so the user sees their write.
      setFeed((existing) => (existing ? [created, ...existing] : [created]));
    } catch (err) {
      setPostError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Feed</h1>
      <p style={{ opacity: 0.7 }}>
        Anyone can read. Signed-in visitors can post. The platform gate
        decides who can mutate — anonymous POSTs get bounced to{" "}
        <code>mcp.coders.kr/sso/login</code> before they reach this app.
      </p>

      {me === undefined ? null : me ? (
        <form
          onSubmit={onSubmit}
          style={{
            background: "#f8fafc",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "1rem",
            margin: "1rem 0",
          }}
        >
          <label
            htmlFor="body"
            style={{ display: "block", marginBottom: ".5rem" }}
          >
            Post as <strong>{me.display_name}</strong>
          </label>
          <textarea
            name="body"
            id="body"
            required
            maxLength={280}
            rows={3}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
          <div
            style={{
              marginTop: ".5rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: ".75rem",
            }}
          >
            <span
              style={{
                color: "#dc2626",
                fontSize: ".88em",
                minHeight: "1.2em",
                flex: 1,
              }}
            >
              {postError ?? ""}
            </span>
            <button
              type="submit"
              disabled={posting}
              style={{
                padding: ".4em 1em",
                background: posting ? "#475569" : "#0f172a",
                color: "white",
                border: 0,
                borderRadius: 6,
                cursor: posting ? "wait" : "pointer",
              }}
            >
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
        </form>
      ) : (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "1rem",
            margin: "1rem 0",
          }}
        >
          <p style={{ margin: "0 0 .6rem" }}>Sign in to post.</p>
          <SignInLink />
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {feed === null && (
          <li style={{ opacity: 0.5 }}>Loading…</li>
        )}
        {feed && feed.length === 0 && (
          <li style={{ opacity: 0.6 }}>No posts yet. Be the first.</li>
        )}
        {feed?.map((p) => (
          <li
            key={p.id}
            style={{
              padding: "1rem 0",
              borderBottom: "1px solid #e5e7eb",
            }}
          >
            <div style={{ fontSize: ".9em", opacity: 0.7 }}>
              {p.author_name} · {new Date(p.created_at).toLocaleString()}
            </div>
            <div style={{ marginTop: ".25rem" }}>{p.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
