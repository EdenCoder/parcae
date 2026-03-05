/**
 * Parcae Example App — minimal working backend.
 *
 * This is ALL you need for a working API with:
 * - Auto-CRUD routes for Posts (GET/POST/PUT/DELETE/PATCH)
 * - Scoped access control (users can only edit their own posts)
 * - Realtime query subscriptions via Socket.IO
 * - Background job processing
 * - Better Auth (email + password)
 *
 * Run:
 *   DATABASE_URL=postgresql://localhost:5432/parcae_example node index.ts
 */

import { createApp } from "@parcae/backend";
import { Post } from "./models/Post";
import { User } from "./models/User";

// Import controllers/hooks/jobs — they self-register on import
import "./controllers/health";
import "./hooks/post-log";
import "./jobs/post-index";

const app = createApp({
  models: [User, Post],
  auth: {
    providers: ["email"],
  },
});

app.start({ port: 3000 }).catch(console.error);
