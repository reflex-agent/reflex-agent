import { NextRequest, NextResponse } from "next/server";
import { installFromArchive } from "@/lib/server/utilities/archive";
import type { UtilityScope } from "@/lib/server/utilities/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Install a utility from an uploaded `.zip`. multipart/form-data with a
 * `file` (the archive) and `scope` ("global" | "project") + optional
 * `rootId` for project scope.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "expected multipart/form-data" },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { ok: false, error: "missing 'file'" },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: `archive exceeds ${MAX_UPLOAD_BYTES} bytes` },
      { status: 413 },
    );
  }
  const scopeRaw = String(form.get("scope") ?? "global");
  const scope: UtilityScope = scopeRaw === "project" ? "project" : "global";
  const rootId = form.get("rootId");

  try {
    const zip = new Uint8Array(await file.arrayBuffer());
    const res = await installFromArchive({
      zip,
      scope,
      ...(scope === "project" && typeof rootId === "string" && rootId
        ? { rootId }
        : {}),
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
