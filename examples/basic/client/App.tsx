/**
 * React client example — connects to the Parcae backend.
 *
 * Demonstrates:
 * - createClient() with Socket.IO transport
 * - ParcaeProvider for React context
 * - useQuery() for realtime data
 * - Suspense for lazy-loaded references (post.user)
 */

import React, { Suspense } from "react";
import { createClient } from "@parcae/sdk";
import { ParcaeProvider, useQuery } from "@parcae/sdk/react";
import { Post } from "../models/Post";

// Create the client — connects to the backend via Socket.IO
const client = createClient({
  url: "http://localhost:3000",
  transport: "socket",
});

// Or use SSE (no WebSocket needed):
// const client = createClient({
//   url: "http://localhost:3000",
//   transport: "sse",
// });

function PostList() {
  const { items: posts, loading } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc" as any),
  );

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Posts</h1>
      {posts.map((post: any) => (
        <article key={post.id}>
          <h2>{post.__data.title}</h2>
          <Suspense fallback={<span>Loading author...</span>}>
            <AuthorName post={post} />
          </Suspense>
        </article>
      ))}
    </div>
  );
}

function AuthorName({ post }: { post: any }) {
  // post.user triggers a lazy-load via Suspense
  return <span>By {post.user?.name ?? "Anonymous"}</span>;
}

export default function App() {
  return (
    <ParcaeProvider client={client}>
      <PostList />
    </ParcaeProvider>
  );
}
