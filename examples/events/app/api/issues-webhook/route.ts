import { events, issueCreated } from "../../../lib/events";

// Wherever upstream changes arrive. Verify the upstream's own signature first.
export async function POST(request: Request) {
  const { id, issue } = await request.json();
  await events.emit(
    issueCreated,
    { id: issue.id, title: issue.title, projectId: issue.projectId },
    // Stable for this occurrence, so upstream retries don't duplicate events.
    { id, occurredAt: new Date(issue.createdAt) },
  );
  return new Response(null, { status: 202 });
}
