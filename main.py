import os, time, sqlite3, threading, logging
from datetime import datetime
from zoneinfo import ZoneInfo
import requests
from flask import Flask, jsonify

TOKEN = os.getenv("BALE_BOT_TOKEN", "").strip()
API = "https://tapi.bale.ai/bot" + TOKEN
DB = os.getenv("DB_PATH", "ponz.db")
TZ = ZoneInfo(os.getenv("TIMEZONE", "Asia/Tehran"))
ADMINS = {x.strip().lower().lstrip("@") for x in os.getenv("BOOTSTRAP_ADMIN_USERNAMES", "me_god_me,alireza_xri,taha1291mani,kian_sa").split(",") if x.strip()}
app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ponz")
MENU = [["📋 ثبت حضور و غیاب", "⚠️ ثبت انضباطی"], ["👥 فهرست اعضا", "➕ افزودن عضو"], ["📊 گزارش امروز", "👤 وضعیت من"], ["📚 سوابق انضباطی", "🧑‍💼 مدیریت مسئولان"]]

def db():
    c = sqlite3.connect(DB, timeout=20)
    c.row_factory = sqlite3.Row
    return c

def now():
    return datetime.now(TZ).isoformat(timespec="seconds")

def init():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT, name TEXT, role TEXT DEFAULT 'member', active INTEGER DEFAULT 1, created TEXT);
        CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, status TEXT, note TEXT, registrar INTEGER, created TEXT);
        CREATE TABLE IF NOT EXISTS discipline(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, details TEXT, registrar INTEGER, created TEXT);
        CREATE TABLE IF NOT EXISTS sessions(user_id INTEGER PRIMARY KEY, state TEXT, data TEXT DEFAULT '');
        """)

def api(method, payload=None, get=False):
    if not TOKEN:
        raise RuntimeError("BALE_BOT_TOKEN is missing")
    fn = requests.get if get else requests.post
    res = fn(f"{API}/{method}", params=payload if get else None, json=None if get else (payload or {}), timeout=40)
    res.raise_for_status()
    data = res.json()
    if not data.get("ok"):
        raise RuntimeError(str(data))
    return data.get("result")

def send(uid, message, keyboard=None):
    p = {"chat_id": uid, "text": message}
    if keyboard:
        p["reply_markup"] = {"keyboard": keyboard, "resize_keyboard": True}
    api("sendMessage", p)

def role(uid):
    with db() as c:
        row = c.execute("SELECT role FROM users WHERE id=? AND active=1", (uid,)).fetchone()
    return row["role"] if row else None

def session(uid, state=None, data=""):
    with db() as c:
        if state is None:
            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        else:
            c.execute("INSERT OR REPLACE INTO sessions VALUES(?,?,?)", (uid, state, data))
        c.commit()

def get_session(uid):
    with db() as c:
        return c.execute("SELECT state,data FROM sessions WHERE user_id=?", (uid,)).fetchone()

def members():
    with db() as c:
        return c.execute("SELECT id,name FROM users WHERE active=1 ORDER BY name").fetchall()

def handle(msg):
    sender = msg.get("from") or {}
    uid = sender.get("id")
    if not uid:
        return
    username = (sender.get("username") or "").lower().lstrip("@")
    name = " ".join(x for x in [sender.get("first_name"), sender.get("last_name")] if x) or username or str(uid)
    with db() as c:
        old = c.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
        if old:
            c.execute("UPDATE users SET username=?,name=? WHERE id=?", (username, name, uid))
        else:
            c.execute("INSERT INTO users(id,username,name,role,created) VALUES(?,?,?,?,?)", (uid, username, name, "admin" if username in ADMINS else "member", now()))
        c.commit()
    current_role = role(uid)
    chat_id = (msg.get("chat") or {}).get("id", uid)
    text = (msg.get("text") or "").strip()
    if chat_id != uid:
        send(chat_id, "لطفاً فقط در گفت‌وگوی خصوصی با بات کار کنید.")
        return
    if text in ("/start", "شروع"):
        label = "مدیر اصلی" if current_role == "admin" else "مسئول ثبت" if current_role == "registrar" else "عضو"
        send(uid, "به سامانه پونز خوش آمدید. نقش شما: " + label, MENU if current_role in ("admin", "registrar") else [["👤 وضعیت من", "📚 سوابق انضباطی"]])
        return
    if not current_role:
        send(uid, "حساب شما فعال نیست؛ با مدیر مدرسه تماس بگیرید.")
        return
    if text == "👤 وضعیت من":
        with db() as c:
            rows = c.execute("SELECT status,note,created FROM attendance WHERE user_id=? ORDER BY id DESC LIMIT 15", (uid,)).fetchall()
        send(uid, "سوابق حضور:\n" + ("\n".join(f"{x['created'][:16]} | {x['status']} | {x['note'] or ''}" for x in rows) if rows else "موردی ثبت نشده."))
        return
    if text == "📚 سوابق انضباطی":
        with db() as c:
            rows = c.execute("SELECT title,details,created FROM discipline WHERE user_id=? ORDER BY id DESC LIMIT 20", (uid,)).fetchall()
        send(uid, "سوابق انضباطی:\n" + ("\n".join(f"{x['created'][:16]} | {x['title']}: {x['details']}" for x in rows) if rows else "موردی ثبت نشده."))
        return
    if current_role not in ("admin", "registrar"):
        send(uid, "دسترسی این بخش برای شما فعال نیست.")
        return
    if text == "👥 فهرست اعضا":
        rows = members()
        send(uid, "اعضا:\n" + ("\n".join(f"{i+1}. {x['name']} — شناسه {x['id']}" for i, x in enumerate(rows)) if rows else "فهرست خالی است."))
        return
    if text == "➕ افزودن عضو":
        session(uid, "new_name")
        send(uid, "نام و نام خانوادگی عضو را بفرستید.")
        return
    if text in ("📋 ثبت حضور و غیاب", "⚠️ ثبت انضباطی"):
        rows = members()
        session(uid, "attendance_member" if text.startswith("📋") else "discipline_member")
        send(uid, "شماره عضو را بفرستید:\n" + "\n".join(f"{i+1}. {x['name']}" for i, x in enumerate(rows)))
        return
    if text == "📊 گزارش امروز":
        day = datetime.now(TZ).date().isoformat()
        with db() as c:
            counts = c.execute("SELECT status,COUNT(*) n FROM attendance WHERE substr(created,1,10)=? GROUP BY status", (day,)).fetchall()
            discipline_count = c.execute("SELECT COUNT(*) n FROM discipline WHERE substr(created,1,10)=?", (day,)).fetchone()["n"]
        send(uid, "گزارش امروز:\n" + ("\n".join(f"{x['status']}: {x['n']}" for x in counts) if counts else "بدون ثبت حضور") + f"\nموارد انضباطی: {discipline_count}")
        return
    if text == "🧑‍💼 مدیریت مسئولان" and current_role == "admin":
        session(uid, "promote")
        send(uid, "شناسه عددی کاربر را برای اعطای نقش مسئول ثبت بفرستید.")
        return
    s = get_session(uid)
    if not s:
        send(uid, "از منو استفاده کنید.", MENU)
        return
    state, data = s["state"], s["data"]
    if state == "new_name":
        session(uid, "new_id", text)
        send(uid, "شناسه عددی بله عضو را بفرستید.")
    elif state == "new_id":
        try:
            target = int(text)
        except ValueError:
            send(uid, "شناسه باید عددی باشد.")
            return
        with db() as c:
            c.execute("INSERT OR IGNORE INTO users(id,name,role,created) VALUES(?,?,?,?)", (target, data, "member", now()))
            c.commit()
        session(uid)
        send(uid, "عضو ثبت شد.", MENU)
    elif state in ("attendance_member", "discipline_member"):
        try:
            target = members()[int(text)-1]["id"]
        except (ValueError, IndexError):
            send(uid, "شماره عضو معتبر نیست.")
            return
        if state == "attendance_member":
            session(uid, "attendance_status", str(target))
            send(uid, "وضعیت را بفرستید: حاضر، غایب، تأخیر یا موجه")
        else:
            session(uid, "discipline_title", str(target))
            send(uid, "عنوان مورد انضباطی را بفرستید.")
    elif state == "attendance_status":
        if text not in ("حاضر", "غایب", "تأخیر", "موجه"):
            send(uid, "یکی از وضعیت‌های اعلام‌شده را بفرستید.")
            return
        session(uid, "attendance_note", data + "|" + text)
        send(uid, "توضیح را بفرستید؛ برای بدون توضیح خط تیره بفرستید.")
    elif state == "attendance_note":
        target, status = data.split("|", 1)
        with db() as c:
            c.execute("INSERT INTO attendance(user_id,status,note,registrar,created) VALUES(?,?,?,?,?)", (int(target), status, "" if text == "-" else text, uid, now()))
            c.commit()
        session(uid)
        send(uid, "حضور و غیاب ثبت شد.", MENU)
    elif state == "discipline_title":
        session(uid, "discipline_details", data + "|" + text)
        send(uid, "شرح مورد را بفرستید.")
    elif state == "discipline_details":
        target, title = data.split("|", 1)
        with db() as c:
            c.execute("INSERT INTO discipline(user_id,title,details,registrar,created) VALUES(?,?,?,?,?)", (int(target), title, text, uid, now()))
            c.commit()
        session(uid)
        send(uid, "مورد انضباطی ثبت شد.", MENU)
    elif state == "promote" and current_role == "admin":
        try:
            target = int(text)
        except ValueError:
            send(uid, "شناسه باید عددی باشد.")
            return
        with db() as c:
            c.execute("UPDATE users SET role='registrar' WHERE id=?", (target,))
            c.commit()
        session(uid)
        send(uid, "در صورت وجود حساب، نقش مسئول ثبت اعمال شد.", MENU)
    else:
        session(uid)
        send(uid, "فرایند لغو شد.", MENU)

@app.get("/")
def health():
    return jsonify(service="Ponz Bale Bot", status="running")

def polling():
    offset = None
    while True:
        try:
            params = {"timeout": 25}
            if offset is not None:
                params["offset"] = offset
            for update in api("getUpdates", params, get=True) or []:
                offset = update.get("update_id", 0) + 1
                if update.get("message"):
                    try:
                        handle(update["message"])
                    except Exception:
                        log.exception("update processing failed")
        except Exception:
            log.exception("polling failed")
            time.sleep(5)

if __name__ == "__main__":
    init()
    if TOKEN:
        threading.Thread(target=polling, daemon=True).start()
    else:
        log.warning("BALE_BOT_TOKEN is not configured")
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "10000")))
