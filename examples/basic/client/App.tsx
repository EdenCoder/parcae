/**
 * React client example — connects to the Parcae backend.
 *
 * Demonstrates:
 * - createClient() with Socket.IO transport
 * - ParcaeProvider for React context
 * - useQuery() for realtime data
 * - Explicit ref expansion for post.user
 */

import { createClient } from '@parcae/sdk';
import { ParcaeProvider, useQuery } from '@parcae/sdk/react';
import { Post } from '../models/Post';

// Create the client — connects to the backend via Socket.IO
const client = createClient({
  url: 'http://localhost:3000',
  getToken: async () => null,
});
const ClientPost = client.bind(Post);

function PostList() {
  const { items: posts, loading } = useQuery(
    ClientPost.where({ published: true })
      .orderBy('createdAt', 'desc')
      .expand('user'),
  );

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Posts</h1>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <AuthorName post={post} />
        </article>
      ))}
    </div>
  );
}

function AuthorName({ post }: { post: Post }) {
  const user = typeof post.user === 'object' ? post.user : null;
  return <span>By {user?.name ?? 'Anonymous'}</span>;
}

export default function App() {
  return (
    <ParcaeProvider client={client}>
      <PostList />
    </ParcaeProvider>
  );
}
