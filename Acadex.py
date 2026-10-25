"""Student Performance Tracker - Flask backend (Python) + SQLite.
Features: teacher login, students, marks over time, attendance, CSV export."""
import csv, io, os, re, secrets, sqlite3
from datetime import date, datetime
from functools import wraps
from flask import Flask, Response, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # photo uploads
DB = "students.db"


def _secret():
    if os.path.exists(".secret_key"):
        return open(".secret_key").read()
    key = secrets.token_hex(32)
    open(".secret_key", "w").write(key)
    return key


app.secret_key = os.environ.get("SECRET_KEY") or _secret()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db:
        db.close()


def init_db():
    db = sqlite3.connect(DB)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, teacher_id INTEGER);
    CREATE TABLE IF NOT EXISTS students(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, roll TEXT NOT NULL UNIQUE, class TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS marks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        subject TEXT NOT NULL, score REAL NOT NULL, max_score REAL NOT NULL DEFAULT 100,
        date TEXT);
    CREATE TABLE IF NOT EXISTS attendance(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
        UNIQUE(student_id, date));
    CREATE TABLE IF NOT EXISTS teachers(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE, subject_code TEXT NOT NULL,
        subject_name TEXT NOT NULL, phone TEXT DEFAULT '', email TEXT DEFAULT '',
        department TEXT DEFAULT '', designation TEXT DEFAULT '', photo TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS timetable(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class TEXT NOT NULL, day INTEGER NOT NULL CHECK(day BETWEEN 0 AND 5),
        start TEXT NOT NULL, end TEXT NOT NULL,
        subject TEXT NOT NULL, teacher TEXT NOT NULL, room TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS activities(
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, category TEXT NOT NULL,
        coach TEXT DEFAULT '', day INTEGER, start TEXT DEFAULT '', end TEXT DEFAULT '', venue TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS enrollments(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'Member', UNIQUE(activity_id, student_id));
    CREATE TABLE IF NOT EXISTS achievements(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        title TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'School', date TEXT);
    CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, subject TEXT, message TEXT,
        created TEXT DEFAULT CURRENT_TIMESTAMP);
    """)
    cols = [r[1] for r in db.execute("PRAGMA table_info(marks)")]
    if "date" not in cols:  # upgrade a database from the first version
        db.execute("ALTER TABLE marks ADD COLUMN date TEXT")
        db.execute("UPDATE marks SET date=?", (date.today().isoformat(),))
    if "teacher_id" not in [r[1] for r in db.execute("PRAGMA table_info(users)")]:
        db.execute("ALTER TABLE users ADD COLUMN teacher_id INTEGER")  # upgrade older databases
    have = [r[1] for r in db.execute("PRAGMA table_info(teachers)")]
    for col in ("department", "designation", "photo"):
        if col not in have:
            db.execute(f"ALTER TABLE teachers ADD COLUMN {col} TEXT DEFAULT ''")
    db.commit()
    db.close()


def login_required(f):
    @wraps(f)
    def wrap(*a, **k):
        if "user" not in session:
            return jsonify(error="Please log in."), 401
        return f(*a, **k)
    return wrap


def grade(pct):
    for cut, g_ in [(90, "A+"), (80, "A"), (70, "B"), (60, "C"), (50, "D")]:
        if pct >= cut:
            return g_
    return "F"


def student_dict(row, db):
    marks = db.execute("SELECT * FROM marks WHERE student_id=? ORDER BY date", (row["id"],)).fetchall()
    total, maxi = sum(m["score"] for m in marks), sum(m["max_score"] for m in marks)
    pct = round(total / maxi * 100, 1) if maxi else 0
    att = {r["status"]: r["n"] for r in db.execute(
        "SELECT status, COUNT(*) n FROM attendance WHERE student_id=? GROUP BY status", (row["id"],))}
    days = sum(att.values())
    attended = att.get("present", 0) + att.get("late", 0)
    acts = [dict(r) for r in db.execute(
        """SELECT a.id, a.name, a.category, e.role FROM enrollments e JOIN activities a ON a.id=e.activity_id
           WHERE e.student_id=? ORDER BY a.category, a.name""", (row["id"],))]
    trophies = db.execute("SELECT COUNT(*) FROM achievements WHERE student_id=?", (row["id"],)).fetchone()[0]
    return {
        "activities": acts, "trophies": trophies,
        "id": row["id"], "name": row["name"], "roll": row["roll"], "class": row["class"],
        "marks": [dict(m) for m in marks], "percentage": pct, "grade": grade(pct) if maxi else "-",
        "attendance": {"days": days, "attended": attended, "late": att.get("late", 0),
                       "pct": round(attended / days * 100, 1) if days else None},
    }


# ---------- pages & auth ----------
@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/me")
def me():
    n = get_db().execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return jsonify(user=session.get("user"), setup_needed=n == 0)


def clean_teacher(d):
    name, code, subj, phone, email, dept, desig = (str(d.get(k, "")).strip() for k in
        ("name", "subject_code", "subject_name", "phone", "email", "department", "designation"))
    if not (name and code and subj):
        return None, "Name, subject code and subject name are required."
    if phone and not re.fullmatch(r"[0-9+\-\s()]{7,20}", phone):
        return None, "Enter a valid phone number."
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return None, "Enter a valid email address."
    return (name, code, subj, phone, email, dept[:80], desig[:80]), None


@app.post("/api/setup")
def setup():
    db = get_db()
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return jsonify(error="Setup is already done. Please log in."), 403
    d = request.get_json(force=True)
    u, p = d.get("username", "").strip(), d.get("password", "")
    if not u or len(p) < 6:
        return jsonify(error="Enter a username and a password of at least 6 characters."), 400
    vals, err = clean_teacher({**d, "name": d.get("name") or u})
    if err:
        return jsonify(error=err), 400
    cur = db.execute("INSERT INTO teachers(name, subject_code, subject_name, phone, email, department, designation) VALUES(?,?,?,?,?,?,?)", vals)
    db.execute("INSERT INTO users(username, password_hash, teacher_id) VALUES(?,?,?)",
               (u, generate_password_hash(p), cur.lastrowid))
    db.commit()
    session["user"] = u
    return jsonify(user=u)


@app.post("/api/login")
def login():
    d = request.get_json(force=True)
    row = get_db().execute("SELECT * FROM users WHERE username=?", (d.get("username", "").strip(),)).fetchone()
    if not row or not check_password_hash(row["password_hash"], d.get("password", "")):
        return jsonify(error="Wrong username or password."), 401
    session["user"] = row["username"]
    return jsonify(user=row["username"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------- students & marks ----------
@app.get("/api/students")
@login_required
def list_students():
    db = get_db()
    return jsonify([student_dict(r, db) for r in db.execute("SELECT * FROM students ORDER BY name")])


@app.post("/api/students")
@login_required
def add_student():
    d = request.get_json(force=True)
    name, roll, cls = (d.get(k, "").strip() for k in ("name", "roll", "class"))
    if not (name and roll and cls):
        return jsonify(error="Name, roll number and class are required."), 400
    try:
        db = get_db()
        cur = db.execute("INSERT INTO students(name, roll, class) VALUES(?,?,?)", (name, roll, cls))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="That roll number already exists."), 409
    return jsonify(ok=True, id=cur.lastrowid), 201


@app.delete("/api/students/<int:sid>")
@login_required
def delete_student(sid):
    db = get_db()
    db.execute("DELETE FROM students WHERE id=?", (sid,))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/students/<int:sid>/marks")
@login_required
def add_mark(sid):
    d = request.get_json(force=True)
    try:
        subject, score = d["subject"].strip(), float(d["score"])
        max_score = float(d.get("max_score") or 100)
        day = (d.get("date") or date.today().isoformat())
        date.fromisoformat(day)
    except (KeyError, ValueError, AttributeError):
        return jsonify(error="Enter a subject, numeric scores and a valid date."), 400
    if not subject or max_score <= 0 or not 0 <= score <= max_score:
        return jsonify(error="Score must be between 0 and the maximum."), 400
    db = get_db()
    db.execute("INSERT INTO marks(student_id, subject, score, max_score, date) VALUES(?,?,?,?,?)",
               (sid, subject, score, max_score, day))
    db.commit()
    return jsonify(ok=True), 201


@app.delete("/api/marks/<int:mid>")
@login_required
def delete_mark(mid):
    db = get_db()
    db.execute("DELETE FROM marks WHERE id=?", (mid,))
    db.commit()
    return jsonify(ok=True)


# ---------- attendance ----------
@app.get("/api/attendance")
@login_required
def get_attendance():
    day = request.args.get("date") or date.today().isoformat()
    rows = get_db().execute("""SELECT s.id, s.name, s.roll, s.class, a.status FROM students s
        LEFT JOIN attendance a ON a.student_id=s.id AND a.date=? ORDER BY s.name""", (day,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/attendance")
@login_required
def save_attendance():
    d = request.get_json(force=True)
    try:
        day = date.fromisoformat(d["date"]).isoformat()
        recs = [(int(r["student_id"]), day, r["status"]) for r in d["records"]
                if r["status"] in ("present", "absent", "late")]
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Invalid attendance data."), 400
    db = get_db()
    db.executemany("""INSERT INTO attendance(student_id, date, status) VALUES(?,?,?)
        ON CONFLICT(student_id, date) DO UPDATE SET status=excluded.status""", recs)
    db.commit()
    return jsonify(saved=len(recs))


# ---------- my profile (shown first after login) ----------
def current_user(db):
    return db.execute("SELECT * FROM users WHERE username=?", (session.get("user"),)).fetchone()


@app.get("/api/profile")
@login_required
def get_profile():
    db = get_db()
    u = current_user(db)
    if not u:
        return jsonify(error="Please log in."), 401
    t = db.execute("SELECT * FROM teachers WHERE id=?", (u["teacher_id"],)).fetchone() if u["teacher_id"] else None
    stats, today = {"week": 0, "classes": [], "students": 0}, []
    if t:
        slots = db.execute("SELECT * FROM timetable WHERE teacher=? COLLATE NOCASE ORDER BY day, start",
                           (t["name"],)).fetchall()
        classes = sorted({s["class"] for s in slots})
        students = sum(db.execute("SELECT COUNT(*) FROM students WHERE class=? COLLATE NOCASE", (c,)).fetchone()[0]
                       for c in classes)
        stats = {"week": len(slots), "classes": classes, "students": students}
        today = [dict(s) for s in slots if s["day"] == date.today().weekday()]
    return jsonify(user=u["username"], teacher=dict(t) if t else None, stats=stats, today=today)


@app.post("/api/profile")
@login_required
def save_profile():
    vals, err = clean_teacher(request.get_json(force=True))
    if err:
        return jsonify(error=err), 400
    db = get_db()
    u = current_user(db)
    if not u:
        return jsonify(error="Please log in."), 401
    try:
        old = db.execute("SELECT * FROM teachers WHERE id=?", (u["teacher_id"],)).fetchone() if u["teacher_id"] else None
        if old:
            db.execute("UPDATE teachers SET name=?, subject_code=?, subject_name=?, phone=?, email=?, department=?, designation=? WHERE id=?",
                       (*vals, old["id"]))
            db.execute("UPDATE timetable SET teacher=? WHERE teacher=? COLLATE NOCASE", (vals[0], old["name"]))
        else:
            cur = db.execute("INSERT INTO teachers(name, subject_code, subject_name, phone, email, department, designation) VALUES(?,?,?,?,?,?,?)", vals)
            db.execute("UPDATE users SET teacher_id=? WHERE id=?", (cur.lastrowid, u["id"]))
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        return jsonify(error="A teacher with that name already exists."), 409
    return jsonify(ok=True)


@app.post("/api/profile/photo")
@login_required
def upload_photo():
    db = get_db()
    u = current_user(db)
    t = db.execute("SELECT * FROM teachers WHERE id=?", (u["teacher_id"],)).fetchone() if u and u["teacher_id"] else None
    if not t:
        return jsonify(error="Save your teacher profile first."), 400
    f = request.files.get("photo")
    data = f.read(3 * 1024 * 1024 + 1) if f else b""
    if not data:
        return jsonify(error="Choose an image."), 400
    if len(data) > 3 * 1024 * 1024:
        return jsonify(error="That image is over 3 MB."), 400
    if data[:3] == b"\xff\xd8\xff":
        ext = ".jpg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ext = ".png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = ".webp"
    else:
        return jsonify(error="Please upload a JPG, PNG or WebP image."), 400
    folder = os.path.join(app.root_path, "static", "uploads")
    os.makedirs(folder, exist_ok=True)
    name = f"teacher_{t['id']}_{secrets.token_hex(4)}{ext}"
    with open(os.path.join(folder, name), "wb") as out:
        out.write(data)
    old = os.path.join(folder, os.path.basename(t["photo"] or ""))
    if t["photo"] and os.path.basename(t["photo"]).startswith("teacher_") and os.path.isfile(old):
        os.remove(old)
    url = f"/static/uploads/{name}"
    db.execute("UPDATE teachers SET photo=? WHERE id=?", (url, t["id"]))
    db.commit()
    return jsonify(photo=url)


# ---------- teacher details ----------
@app.get("/api/teachers")
@login_required
def list_teachers():
    rows = get_db().execute("""SELECT t.*, u.username FROM teachers t
        LEFT JOIN users u ON u.teacher_id=t.id ORDER BY t.name""").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/teachers")
@login_required
def add_teacher():
    d = request.get_json(force=True)
    vals, err = clean_teacher(d)
    if err:
        return jsonify(error=err), 400
    username, password = str(d.get("username", "")).strip(), d.get("password", "")
    if username and len(password) < 6:
        return jsonify(error="A login needs a password of at least 6 characters."), 400
    db = get_db()
    try:
        cur = db.execute("INSERT INTO teachers(name, subject_code, subject_name, phone, email, department, designation) VALUES(?,?,?,?,?,?,?)", vals)
        if username:
            db.execute("INSERT INTO users(username, password_hash, teacher_id) VALUES(?,?,?)",
                       (username, generate_password_hash(password), cur.lastrowid))
        db.commit()
    except sqlite3.IntegrityError as e:
        db.rollback()
        return jsonify(error="That username is taken." if "username" in str(e)
                       else "A teacher with that name already exists."), 409
    return jsonify(ok=True, id=cur.lastrowid), 201


@app.delete("/api/teachers/<int:tid>")
@login_required
def delete_teacher(tid):
    db = get_db()
    db.execute("UPDATE users SET teacher_id=NULL WHERE teacher_id=?", (tid,))
    db.execute("DELETE FROM teachers WHERE id=?", (tid,))
    db.commit()
    return jsonify(ok=True)


# ---------- timetable ----------
@app.get("/api/timetable")
@login_required
def list_slots():
    rows = get_db().execute("SELECT * FROM timetable ORDER BY day, start, class").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/timetable")
@login_required
def add_slot():
    d = request.get_json(force=True)
    cls, subject, teacher, room = (str(d.get(k, "")).strip() for k in ("class", "subject", "teacher", "room"))
    try:
        day = int(d["day"])
        s, e = d["start"], d["end"]
        datetime.strptime(s, "%H:%M"); datetime.strptime(e, "%H:%M")
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Choose a day and valid start and end times."), 400
    if not (cls and subject and teacher) or not 0 <= day <= 5 or s >= e:
        return jsonify(error="Fill every field; the end time must be after the start time."), 400
    db = get_db()
    q = "SELECT * FROM timetable WHERE day=? AND start<? AND ?<end AND "
    c = db.execute(q + "class=? COLLATE NOCASE", (day, e, s, cls)).fetchone()
    if c:
        return jsonify(error=f"Class {c['class']} already has {c['subject']} from {c['start']} to {c['end']}."), 409
    t = db.execute(q + "teacher=? COLLATE NOCASE", (day, e, s, teacher)).fetchone()
    if t:
        return jsonify(error=f"{t['teacher']} is already teaching class {t['class']} from {t['start']} to {t['end']}."), 409
    cur = db.execute("INSERT INTO timetable(class, day, start, end, subject, teacher, room) VALUES(?,?,?,?,?,?,?)",
                     (cls, day, s, e, subject, teacher, room))
    db.commit()
    return jsonify(ok=True, id=cur.lastrowid), 201


@app.delete("/api/timetable/<int:tid>")
@login_required
def delete_slot(tid):
    db = get_db()
    db.execute("DELETE FROM timetable WHERE id=?", (tid,))
    db.commit()
    return jsonify(ok=True)


# ---------- extracurricular activities ----------
CATEGORIES = ["Music", "Dance", "Arts", "Sports", "Clubs", "Drama", "Debate",
              "Science & Tech", "Community service", "Other"]
LEVELS = ["School", "Inter-school", "District", "State", "National", "International", "Other"]
ROLES = ["Member", "Captain", "Vice captain", "Lead", "Coordinator"]


@app.get("/api/activities")
@login_required
def list_activities():
    db = get_db()
    out = []
    for a in db.execute("SELECT * FROM activities ORDER BY category, name").fetchall():
        d = dict(a)
        d["members"] = [dict(r) for r in db.execute(
            """SELECT s.id student_id, s.name, s.roll, s.class, e.role FROM enrollments e
               JOIN students s ON s.id=e.student_id WHERE e.activity_id=? ORDER BY s.name""", (a["id"],))]
        d["achievements"] = [dict(r) for r in db.execute(
            """SELECT x.id, x.student_id, s.name, x.title, x.level, x.date FROM achievements x
               JOIN students s ON s.id=x.student_id WHERE x.activity_id=? ORDER BY x.date DESC""", (a["id"],))]
        out.append(d)
    return jsonify(out)


@app.post("/api/activities")
@login_required
def add_activity():
    d = request.get_json(force=True)
    name, cat, coach, venue = (str(d.get(k, "")).strip() for k in ("name", "category", "coach", "venue"))
    if not name or cat not in CATEGORIES:
        return jsonify(error="Enter an activity name and choose a category."), 400
    try:
        day = None if d.get("day") in ("", None) else int(d["day"])
        start, end = (d.get("start") or "").strip(), (d.get("end") or "").strip()
        if bool(start) != bool(end):
            raise ValueError
        if start:
            datetime.strptime(start, "%H:%M"); datetime.strptime(end, "%H:%M")
            if start >= end:
                raise ValueError
        if day is not None and not 0 <= day <= 5:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify(error="Give both a start and an end time (end after start), or leave both empty."), 400
    try:
        db = get_db()
        cur = db.execute("INSERT INTO activities(name, category, coach, day, start, end, venue) VALUES(?,?,?,?,?,?,?)",
                         (name, cat, coach, day, start, end, venue))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="An activity with that name already exists."), 409
    return jsonify(ok=True, id=cur.lastrowid), 201


@app.delete("/api/activities/<int:aid>")
@login_required
def delete_activity(aid):
    db = get_db()
    db.execute("DELETE FROM activities WHERE id=?", (aid,))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/activities/<int:aid>/members")
@login_required
def add_member(aid):
    d = request.get_json(force=True)
    role = d.get("role") if d.get("role") in ROLES else "Member"
    try:
        sid = int(d["student_id"])
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Choose a student."), 400
    db = get_db()
    try:
        db.execute("INSERT INTO enrollments(activity_id, student_id, role) VALUES(?,?,?)", (aid, sid, role))
        db.commit()
    except sqlite3.IntegrityError as e:
        return (jsonify(error="That student is already a member."), 409) if "UNIQUE" in str(e) \
            else (jsonify(error="Student or activity not found."), 404)
    return jsonify(ok=True), 201


@app.delete("/api/activities/<int:aid>/members/<int:sid>")
@login_required
def remove_member(aid, sid):
    db = get_db()
    db.execute("DELETE FROM achievements WHERE activity_id=? AND student_id=?", (aid, sid))
    db.execute("DELETE FROM enrollments WHERE activity_id=? AND student_id=?", (aid, sid))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/activities/<int:aid>/achievements")
@login_required
def add_achievement(aid):
    d = request.get_json(force=True)
    title = str(d.get("title", "")).strip()[:120]
    level = d.get("level") if d.get("level") in LEVELS else "School"
    try:
        sid = int(d["student_id"])
        day = date.fromisoformat(d.get("date") or date.today().isoformat()).isoformat()
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Choose a student and a valid date."), 400
    if not title:
        return jsonify(error="Describe the achievement."), 400
    db = get_db()
    if not db.execute("SELECT 1 FROM enrollments WHERE activity_id=? AND student_id=?", (aid, sid)).fetchone():
        return jsonify(error="Enroll the student in this activity first."), 400
    db.execute("INSERT INTO achievements(activity_id, student_id, title, level, date) VALUES(?,?,?,?,?)",
               (aid, sid, title, level, day))
    db.commit()
    return jsonify(ok=True), 201


@app.delete("/api/achievements/<int:xid>")
@login_required
def delete_achievement(xid):
    db = get_db()
    db.execute("DELETE FROM achievements WHERE id=?", (xid,))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/export/activities.csv")
@login_required
def export_activities():
    rows = get_db().execute("""SELECT a.name, a.category, s.name, s.roll, s.class, e.role,
        (SELECT COUNT(*) FROM achievements x WHERE x.activity_id=a.id AND x.student_id=s.id)
        FROM enrollments e JOIN activities a ON a.id=e.activity_id JOIN students s ON s.id=e.student_id
        ORDER BY a.category, a.name, s.name""").fetchall()
    return csv_response("activities.csv", ["Activity", "Category", "Student", "Roll", "Class", "Role", "Achievements"], rows)


# ---------- contact form (public) ----------
@app.post("/api/contact")
def contact():
    d = request.get_json(force=True)
    email, subject, msg = (str(d.get(k, "")).strip() for k in ("email", "subject", "message"))
    if "@" not in email or not subject or not msg or len(msg) > 2000:
        return jsonify(error="Enter a valid email, a subject and a message."), 400
    db = get_db()
    db.execute("INSERT INTO messages(email, subject, message) VALUES(?,?,?)", (email, subject, msg))
    db.commit()
    return jsonify(ok=True), 201


# ---------- CSV export ----------
def csv_response(name, header, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={name}"})


@app.get("/api/export/marks.csv")
@login_required
def export_marks():
    rows = get_db().execute("""SELECT s.name, s.roll, s.class, m.subject, m.score, m.max_score,
        ROUND(m.score*100.0/m.max_score,1), m.date FROM marks m JOIN students s ON s.id=m.student_id
        ORDER BY s.name, m.date""").fetchall()
    return csv_response("marks.csv", ["Name", "Roll", "Class", "Subject", "Score", "Out of", "Percent", "Date"], rows)


@app.get("/api/export/attendance.csv")
@login_required
def export_attendance():
    rows = get_db().execute("""SELECT s.name, s.roll, s.class, a.date, a.status FROM attendance a
        JOIN students s ON s.id=a.student_id ORDER BY a.date, s.name""").fetchall()
    return csv_response("attendance.csv", ["Name", "Roll", "Class", "Date", "Status"], rows)


init_db()
if __name__ == "__main__":
    app.run(debug=True)
