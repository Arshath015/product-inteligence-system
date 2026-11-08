import { NextResponse } from "next/server";

export class ProjectIdRequiredError extends Error {
  constructor() {
    super("projectId is required");
  }
}

/** Standard 400 response for routes missing the required projectId. */
export function missingProjectIdResponse() {
  return NextResponse.json({ error: "projectId is required" }, { status: 400 });
}
