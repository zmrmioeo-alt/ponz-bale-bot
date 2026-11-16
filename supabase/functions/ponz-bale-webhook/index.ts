import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("BALE_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("BALE_WEBHOOK_SECRET") ?? "";
const ADMINS = new Set(
  (Deno.env.get("BOOTSTRAP_ADMIN_USERNAMES") ?? "me_god_me,alireza_xri,taha1291mani,kian_sa")
    .split(",").map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
);
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
const legacyServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const serviceKey = secretKeysRaw
  ? JSON.parse(secretKeysRaw).default
  : legacyServiceKey;
if (!serviceKey) throw new Error("Supabase server secret key is not configured");
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const API = "https://tapi.bale.ai/bot" + TOKEN;
const MENU = [
  ["📋 ثبت حضور و غیاب", "⚠️ ثبت انضباطی"],
  ["👥 فهرست اعضا", "➕ افزودن عضو"],
  ["📊 گزارش امروز", "👤 وضعیت من"],
  ["📚 سوابق انضباطی", "🧑‍💼 مدیریت مسئولان"],
];

async function bale(method: string, payload: Record<string, unknown>) {
  if (!TOKEN) throw new Error("BALE_BOT_TOKEN is not configured");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Bale API ${method} failed: ${res.status}`);
  return data.result;
}
async function send(chatId: number | string, message: string, keyboard?: string[][]) {
  const payload: Record<string, unknown> = { chat_id: chatId, text: message };
  if (keyboard) payload.reply_markup = { keyboard, resize_keyboard: true };
  await bale("sendMessage", payload);
}
async function getRole(uid: number) {
  const { data, error } = await db.from("users").select("role").eq("id", uid).eq("active", true).maybeSingle();
  if (error) throw error;
  return data?.role ?? null;
}
async function getMembers() {
  const { data, error } = await db.from("users").select("id,name").eq("active", true).order("name");
  if (error) throw error;
  return data ?? [];
}
async function getSession(uid: number) {
  const { data, error } = await db.from("sessions").select("state,data").eq("user_id", uid).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let payload: Record<string, unknown> = {};
  try { payload = data.data ? JSON.parse(data.data) : {}; } catch { payload = {}; }
  return { state: data.state as string, payload };
}
async function setSession(uid: number, state: string | null, payload: Record<string, unknown> = {}) {
  if (!state) {
    const { error } = await db.from("sessions").delete().eq("user_id", uid);
    if (error) throw error;
    return;
  }
  const { error } = await db.from("sessions").upsert(
    { user_id: uid, state, data: JSON.stringify(payload) },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}
async function ensureUser(sender: Record<string, unknown>) {
  const uid = Number(sender.id);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Invalid Bale user id");
  const username = String(sender.username ?? "").toLowerCase().replace(/^@/, "");
  const name = [sender.first_name, sender.last_name].filter(Boolean).join(" ") || username || String(uid);
  const { data: old, error: readError } = await db.from("users").select("id,role").eq("id", uid).maybeSingle();
  if (readError) throw readError;
  const isAdmin = ADMINS.has(username);
  if (old) {
    const patch: Record<string, unknown> = { username: username || null, name };
    if (isAdmin && old.role !== "admin") patch.role = "admin";
    const { error } = await db.from("users").update(patch).eq("id", uid);
    if (error) throw error;
  } else {
    const { error } = await db.from("users").insert({
      id: uid, username: username || null, name, role: isAdmin ? "admin" : "member", active: true,
    });
    if (error) throw error;
  }
  return { uid, name, username };
}
async function processMessage(msg: Record<string, unknown>) {
  const sender = (msg.from ?? {}) as Record<string, unknown>;
  if (!sender.id) return;
  const { uid } = await ensureUser(sender);
  const chat = (msg.chat ?? {}) as Record<string, unknown>;
  const chatId = Number(chat.id ?? uid);
  if (chatId !== uid) {
    await send(chatId, "لطفاً فقط در گفت‌وگوی خصوصی با بات کار کنید.");
    return;
  }
  const text = String(msg.text ?? "").trim();
  const currentRole = await getRole(uid);

  if (text === "/start" || text === "شروع") {
    const label = currentRole === "admin" ? "مدیر اصلی" : currentRole === "registrar" ? "مسئول ثبت" : "عضو";
    await send(uid, "به سامانه پونز خوش آمدید. نقش شما: " + label,
      currentRole === "admin" || currentRole === "registrar" ? MENU : [["👤 وضعیت من", "📚 سوابق انضباطی"]]);
    return;
  }
  if (!currentRole) {
    await send(uid, "حساب شما فعال نیست؛ با مدیر مدرسه تماس بگیرید.");
    return;
  }
  if (text === "👤 وضعیت من") {
    const { data, error } = await db.from("attendance").select("status,note,created").eq("user_id", uid).order("id", { ascending: false }).limit(15);
    if (error) throw error;
    const lines = (data ?? []).map((x) => `${String(x.created).slice(0,16)} | ${x.status} | ${x.note ?? ""}`);
    await send(uid, "سوابق حضور:\n" + (lines.join("\n") || "موردی ثبت نشده."));
    return;
  }
  if (text === "📚 سوابق انضباطی") {
    const { data, error } = await db.from("discipline").select("title,details,created").eq("user_id", uid).order("id", { ascending: false }).limit(20);
    if (error) throw error;
    const lines = (data ?? []).map((x) => `${String(x.created).slice(0,16)} | ${x.title}: ${x.details}`);
    await send(uid, "سوابق انضباطی:\n" + (lines.join("\n") || "موردی ثبت نشده."));
    return;
  }
  if (currentRole !== "admin" && currentRole !== "registrar") {
    await send(uid, "دسترسی این بخش برای شما فعال نیست.");
    return;
  }
  if (text === "👥 فهرست اعضا") {
    const rows = await getMembers();
    await send(uid, "اعضا:\n" + (rows.map((x, i) => `${i+1}. ${x.name} — شناسه ${x.id}`).join("\n") || "فهرست خالی است."));
    return;
  }
  if (text === "➕ افزودن عضو") {
    await setSession(uid, "new_name");
    await send(uid, "نام و نام خانوادگی عضو را بفرستید.");
    return;
  }
  if (text === "📋 ثبت حضور و غیاب" || text === "⚠️ ثبت انضباطی") {
    const rows = await getMembers();
    await setSession(uid, text.startsWith("📋") ? "attendance_member" : "discipline_member");
    await send(uid, "شماره عضو را بفرستید:\n" + rows.map((x, i) => `${i+1}. ${x.name}`).join("\n"));
    return;
  }
  if (text === "📊 گزارش امروز") {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date());
    const { data: rows, error } = await db.from("attendance").select("status").gte("created", today + "T00:00:00+03:30").lt("created", today + "T24:00:00+03:30");
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of rows ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const { count, error: dErr } = await db.from("discipline").select("*", { count: "exact", head: true }).gte("created", today + "T00:00:00+03:30").lt("created", today + "T24:00:00+03:30");
    if (dErr) throw dErr;
    await send(uid, "گزارش امروز:\n" + (Object.entries(counts).map(([k,v]) => `${k}: ${v}`).join("\n") || "بدون ثبت حضور") + `\nموارد انضباطی: ${count ?? 0}`);
    return;
  }
  if (text === "🧑‍💼 مدیریت مسئولان" && currentRole === "admin") {
    await setSession(uid, "promote");
    await send(uid, "شناسه عددی کاربر را برای اعطای نقش مسئول ثبت بفرستید.");
    return;
  }

  const s = await getSession(uid);
  if (!s) {
    await send(uid, "از منو استفاده کنید.", MENU);
    return;
  }
  const p = s.payload;
  if (s.state === "new_name") {
    await setSession(uid, "new_id", { name: text });
    await send(uid, "شناسه عددی بله عضو را بفرستید.");
  } else if (s.state === "new_id") {
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0) { await send(uid, "شناسه باید عددی باشد."); return; }
    const { error } = await db.from("users").upsert({ id: target, name: String(p.name ?? ""), role: "member", active: true }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
    await setSession(uid, null);
    await send(uid, "عضو ثبت شد.", MENU);
  } else if (s.state === "attendance_member" || s.state === "discipline_member") {
    const index = Number(text) - 1;
    const rows = await getMembers();
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) { await send(uid, "شماره عضو معتبر نیست."); return; }
    const target = Number(rows[index].id);
    if (s.state === "attendance_member") {
      await setSession(uid, "attendance_status", { target });
      await send(uid, "وضعیت را بفرستید: حاضر، غایب، تأخیر یا موجه");
    } else {
      await setSession(uid, "discipline_title", { target });
      await send(uid, "عنوان مورد انضباطی را بفرستید.");
    }
  } else if (s.state === "attendance_status") {
    if (!["حاضر", "غایب", "تأخیر", "موجه"].includes(text)) { await send(uid, "یکی از وضعیت‌های اعلام‌شده را بفرستید."); return; }
    await setSession(uid, "attendance_note", { target: p.target, status: text });
    await send(uid, "توضیح را بفرستید؛ برای بدون توضیح خط تیره بفرستید.");
  } else if (s.state === "attendance_note") {
    const { error } = await db.from("attendance").insert({
      user_id: Number(p.target), status: String(p.status), note: text === "-" ? "" : text, registrar: uid,
    });
    if (error) throw error;
    await setSession(uid, null);
    await send(uid, "حضور و غیاب ثبت شد.", MENU);
  } else if (s.state === "discipline_title") {
    await setSession(uid, "discipline_details", { target: p.target, title: text });
    await send(uid, "شرح مورد را بفرستید.");
  } else if (s.state === "discipline_details") {
    const { error } = await db.from("discipline").insert({
      user_id: Number(p.target), title: String(p.title), details: text, registrar: uid,
    });
    if (error) throw error;
    await setSession(uid, null);
    await send(uid, "مورد انضباطی ثبت شد.", MENU);
  } else if (s.state === "promote" && currentRole === "admin") {
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0) { await send(uid, "شناسه باید عددی باشد."); return; }
    const { error } = await db.from("users").update({ role: "registrar" }).eq("id", target);
    if (error) throw error;
    await setSession(uid, null);
    await send(uid, "در صورت وجود حساب، نقش مسئول ثبت اعمال شد.", MENU);
  } else {
    await setSession(uid, null);
    await send(uid, "فرایند لغو شد.", MENU);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return Response.json({ service: "Ponz Bale Bot", status: "ready", webhook: true });
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!TOKEN || !WEBHOOK_SECRET) return Response.json({ error: "Bot secrets are not configured" }, { status: 503 });

  const setupSecret = req.headers.get("x-ponz-setup-secret") ?? "";
  let update: Record<string, unknown>;
  try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

  if (setupSecret === WEBHOOK_SECRET && update.action === "register_webhook") {
    const baseUrl = `${supabaseUrl}/functions/v1/ponz-bale-webhook`;
    try {
      const result = await bale("setWebhook", { url: baseUrl, secret_token: WEBHOOK_SECRET, allowed_updates: ["message"] });
      return Response.json({ ok: true, registered: true, result });
    } catch (_error) {
      const result = await bale("setWebhook", { url: `${baseUrl}?secret=${encodeURIComponent(WEBHOOK_SECRET)}`, allowed_updates: ["message"] });
      return Response.json({ ok: true, registered: true, fallback: true, result });
    }
  }

  const headerSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const querySecret = new URL(req.url).searchParams.get("secret") ?? "";
  if (headerSecret !== WEBHOOK_SECRET && querySecret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const updateId = Number(update.update_id);
  let claimed = false;
  if (Number.isSafeInteger(updateId)) {
    const { data, error } = await db.from("processed_bale_updates")
      .upsert({ update_id: updateId }, { onConflict: "update_id", ignoreDuplicates: true })
      .select("update_id");
    if (error) return new Response("Database Error", { status: 500 });
    if (!data?.length) return Response.json({ ok: true, duplicate: true });
    claimed = true;
  }
  try {
    if (update.message && typeof update.message === "object") {
      await processMessage(update.message as Record<string, unknown>);
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (claimed) await db.from("processed_bale_updates").delete().eq("update_id", updateId);
    console.error("update processing failed", error instanceof Error ? error.message : "unknown");
    return new Response("Processing failed", { status: 500 });
  }
});
