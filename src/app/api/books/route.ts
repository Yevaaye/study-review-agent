import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON, requireFields } from "@/lib/http";

export const dynamic = "force-dynamic";

// 材料列表
export async function GET() {
  const store = await getStore();
  const textbooks = await store.listTextbooks();
  return Response.json({ textbooks });
}

// 创建材料（手工建一本，不解析）
export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    requireFields(body, ["title"]);
    const store = await getStore();
    const t = await store.createTextbook({
      title: String(body.title),
      author: body.author ? String(body.author) : null,
      subject: body.subject ? String(body.subject) : null,
      source_format: "markdown",
      original_file_name: null,
      storage_key: null,
      mime_type: null,
      file_size_bytes: null,
      content_hash: null,
      parser_version: null,
      source_version: 1,
      status: "ready",
      imported_at: new Date().toISOString(),
      archived_at: null,
    });
    return Response.json({ textbook: t }, { status: 201 });
  } catch (e) {
    return errorResponse(e, "创建材料失败");
  }
}
