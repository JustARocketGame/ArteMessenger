from flask import Flask, request, jsonify, render_template, make_response, redirect, send_file
import sqlite3
from flask_cors import CORS
import bcrypt
from datetime import datetime, timedelta
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import uuid
import os
import time
from dotenv import load_dotenv
import os
from werkzeug.utils import secure_filename

load_dotenv()

call_data = {}
calls = {}

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})  # Разрешить все источники для тестирования

# Directory to save recordings
UPLOAD_FOLDER = 'recordings'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

@app.route('/record/upload', methods=['POST'])
def upload_recording():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401

    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part in the request'}), 400

        file = request.files['file']
        call_id = request.form.get('call_id', 'unknown')
        user = request.form.get('user')

        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400

        # Secure the filename and save the file
        filename = secure_filename(f"recording_{call_id}_{user}_{int(time.time())}.webm")
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(file_path)

        # Optionally, save metadata to the database
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id TEXT,
            username TEXT,
            file_path TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('INSERT INTO recordings (call_id, username, file_path) VALUES (?, ?, ?)',
                  (call_id, user, file_path))
        conn.commit()
        conn.close()

        return jsonify({'message': f'Recording saved successfully as {filename}'}), 200
    except Exception as e:
        print(f"Upload recording error: {e}")
        return jsonify({'error': 'Server error during recording upload'}), 500

def init_db():
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS users 
                     (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                      username TEXT NOT NULL UNIQUE,
                      password TEXT NOT NULL,
                      email TEXT NOT NULL UNIQUE)''')
        c.execute("PRAGMA table_info(users)")
        columns = [col[1] for col in c.fetchall()]
        if 'email' not in columns:
            print("Adding email column to users table")
            c.execute("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
        # В функции init_db() обновите таблицу messages
        c.execute('''CREATE TABLE IF NOT EXISTS messages 
             (id INTEGER PRIMARY KEY AUTOINCREMENT, 
              sender TEXT NOT NULL,
              receiver TEXT NOT NULL,
              message TEXT NOT NULL,
              is_system BOOLEAN DEFAULT FALSE,
              timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS recovery 
                     (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                      username TEXT NOT NULL,
                      recovery_id TEXT NOT NULL UNIQUE,
                      expires_at DATETIME NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS calls 
                     (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                      caller TEXT NOT NULL,
                      receiver TEXT NOT NULL,
                      call_id TEXT NOT NULL UNIQUE,
                      status TEXT NOT NULL DEFAULT 'pending',
                      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)''')
        conn.commit()
    except Exception as e:
        print(f"Database initialization error: {e}")
    finally:
        conn.close()

@app.route('/call/initiate', methods=['POST'])
def initiate_call():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        
        receiver = data.get('receiver')
        if not receiver:
            return jsonify({'error': 'Receiver is required'}), 400
        
        # Проверяем, существует ли пользователь
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username FROM users WHERE username = ?', (receiver,))
        if not c.fetchone():
            conn.close()
            return jsonify({'error': 'User not found'}), 404
        
        # Создаем запись о звонке
        call_id = str(uuid.uuid4())
        c.execute('INSERT INTO calls (caller, receiver, call_id, status) VALUES (?, ?, ?, ?)',
                  (username, receiver, call_id, 'pending'))
        conn.commit()
        conn.close()
        
        return jsonify({'call_id': call_id, 'message': 'Call initiated'}), 200
        
    except Exception as e:
        print(f"Initiate call error: {e}")
        return jsonify({'error': 'Server error during call initiation'}), 500

@app.route('/call/accept', methods=['POST'])
def accept_call():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        
        call_id = data.get('call_id')
        if not call_id:
            return jsonify({'error': 'Call ID is required'}), 400
        
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        
        # Проверяем, существует ли звонок и предназначен ли он текущему пользователю
        c.execute('SELECT caller, receiver FROM calls WHERE call_id = ? AND status = ?',
                  (call_id, 'pending'))
        call = c.fetchone()
        
        if not call or call[1] != username:
            conn.close()
            return jsonify({'error': 'Invalid call or not authorized'}), 400
        
        # Обновляем статус звонка
        c.execute('UPDATE calls SET status = ? WHERE call_id = ?', ('accepted', call_id))
        conn.commit()
        conn.close()
        
        return jsonify({'message': 'Call accepted', 'caller': call[0]}), 200
        
    except Exception as e:
        print(f"Accept call error: {e}")
        return jsonify({'error': 'Server error during call acceptance'}), 500

@app.route('/call/end', methods=['POST'])
def end_call():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        
        call_id = data.get('call_id')
        if not call_id:
            return jsonify({'error': 'Call ID is required'}), 400
        
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        
        # Удаляем запись о звонке
        c.execute('DELETE FROM calls WHERE call_id = ?', (call_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'message': 'Call ended'}), 200
        
    except Exception as e:
        print(f"End call error: {e}")
        return jsonify({'error': 'Server error during call ending'}), 500

@app.route('/call/check', methods=['GET'])
def check_call():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        
        # Проверяем, есть ли ожидающие звонки для текущего пользователя
        c.execute('SELECT call_id, caller FROM calls WHERE receiver = ? AND status = ?',
                  (username, 'pending'))
        call = c.fetchone()
        conn.close()
        
        if call:
            return jsonify({
                'has_call': True,
                'call_id': call[0],
                'caller': call[1]
            }), 200
        else:
            return jsonify({'has_call': False}), 200
            
    except Exception as e:
        print(f"Check call error: {e}")
        return jsonify({'error': 'Server error during call check'}), 500

def check_auth(cookies):
    username = cookies.get('username')
    if not username:
        return None
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username FROM users WHERE username = ?', (username,))
        user = c.fetchone()
        conn.close()
        return user[0] if user else None
    except Exception as e:
        print(f"Auth check error: {e}")
        return None

def send_recovery_email(email, username, recovery_id):
    sender = os.getenv("SMTP_EMAIL", "justarocketgame@gmail.com")
    password = os.getenv("SMTP_PASSWORD", "HALLO")
    recovery_link = f"http://localhost:5000/recovery?id={recovery_id}"
    msg = MIMEMultipart('alternative')
    msg['Subject'] = 'Account Recovery (Arte Messenger)'
    msg['From'] = sender
    msg['To'] = email

    text = f"""
    Hello {username},

    You requested to recover your account. Click the link below to proceed:
    {recovery_link}

    This link will expire in 1 hour.

    If you did not request this, please ignore this email.
    """

    html = f"""
    <html>
        <body>
            <p style="justify-content: center; text-align: center;">Hello {username},</p>
            <p style="justify-content: center; text-align: center;">You requested to recover your account. Click the button below to proceed:</p>
            <div style="margin: 20px 0; justify-content: center; text-align: center;">
                <a href="{recovery_link}" style="background-color: #007bff; color: white; 
                padding: 12px 24px; text-decoration: none; border-radius: 4px; 
                font-family: Arial, sans-serif; font-size: 12px; display: inline-block; justify-content: center; text-align: center;">
                    Open recovery website
                </a>
            </div>
            <p style="justify-content: center; text-align: center;">This link will expire in 1 hour.</p>
            <p style="justify-content: center; text-align: center;">If you did not request this, please ignore this email.</p>
        </body>
    </html>
    """

    part1 = MIMEText(text, 'plain')
    part2 = MIMEText(html, 'html')
    msg.attach(part1)
    msg.attach(part2)
    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(sender, password)
            server.sendmail(sender, email, msg.as_string())
        print(f"Email sent successfully to {email}: {recovery_link}")
        return True
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False

@app.route('/')
def index():
    if check_auth(request.cookies):
        return redirect('/main')
    return render_template('index.html')

@app.route('/register', methods=['GET'])
def register_page():
    if check_auth(request.cookies):
        return redirect('/main')
    return render_template('register.html')

@app.route('/register', methods=['POST'])
def register():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        username = data.get('username')
        password = data.get('password')
        email = data.get('email')
        if not username or not password or not email:
            return jsonify({'error': 'Username, password, and email are required'}), 400
        hashed_password = password
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        try:
            c.execute('INSERT INTO users (username, password, email) VALUES (?, ?, ?)', 
                      (username, hashed_password, email))
            conn.commit()
            response = make_response(jsonify({'message': 'User registered successfully'}), 201)
            response.set_cookie('username', username, max_age=3600)
            return response
        except sqlite3.IntegrityError as e:
            print(f"Database error: {e}")
            return jsonify({'error': 'Username or email already exists'}), 400
        except sqlite3.OperationalError as e:
            print(f"Database operational error: {e}")
            return jsonify({'error': 'Database error: please try again later'}), 500
        finally:
            conn.close()
    except Exception as e:
        print(f"Registration error: {e}")
        return jsonify({'error': 'Server error during registration'}), 500

@app.route('/login', methods=['POST'])
def login():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        username = data.get('username')
        password = data.get('password')
        if not username or not password:
            return jsonify({'error': 'Username and password are required'}), 400
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT password FROM users WHERE username = ?', (username,))
        user = c.fetchone()
        conn.close()
        if user and password == user[0]:
            response = make_response(jsonify({'message': 'Login successful'}), 200)
            response.set_cookie('username', username, max_age=3600)
            return response
        return jsonify({'error': 'Invalid username or password'}), 401
    except Exception as e:
        print(f"Login error: {e}")
        return jsonify({'error': 'Server error during login'}), 500

@app.route('/main')
def main():
    username = check_auth(request.cookies)
    if not username:
        return redirect('/')
    return render_template('main.html', username=username)

@app.route('/logout', methods=['POST'])
def logout():
    response = make_response(jsonify({'message': 'Logged out successfully'}), 200)
    response.delete_cookie('username')
    return response

@app.route('/deleteacc', methods=['POST'])
def deleteacc():
    username = request.cookies.get('username')
    if not username:
        return jsonify({'error': 'No username cookie found'}), 400
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute("DELETE FROM users WHERE username = ?", (username,))
        c.execute("DELETE FROM messages WHERE sender = ? OR receiver = ?", (username, username))
        c.execute("DELETE FROM recovery WHERE username = ?", (username,))
        conn.commit()
        conn.close()
        response = make_response(jsonify({'message': f'Account {username} deleted successfully'}), 200)
        response.delete_cookie('username')
        return response
    except Exception as e:
        print(f"Delete account error: {e}")
        return jsonify({'error': 'Server error during account deletion'}), 500

@app.route('/users', methods=['GET'])
def get_users():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username FROM users WHERE username != ?', (username,))
        users = [row[0] for row in c.fetchall()]
        conn.close()
        return jsonify(users)
    except Exception as e:
        print(f"Get users error: {e}")
        return jsonify({'error': 'Server error while fetching users'}), 500

@app.route('/messages', methods=['GET'])
def get_messages():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    receiver = request.args.get('receiver')
    if not receiver:
        return jsonify({'error': 'Receiver is required'}), 400
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('''SELECT sender, receiver, message, is_system, timestamp 
                     FROM messages 
                     WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) 
                     ORDER BY timestamp''', (username, receiver, receiver, username))
        messages = [{
            'sender': row[0], 
            'receiver': row[1], 
            'message': row[2], 
            'is_system': bool(row[3]),  # Преобразуем в boolean
            'timestamp': row[4]
        } for row in c.fetchall()]
        conn.close()
        return jsonify(messages)
    except Exception as e:
        print(f"Get messages error: {e}")
        return jsonify({'error': 'Server error while fetching messages'}), 500

@app.route('/messages', methods=['POST'])
def send_message():
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        receiver = data.get('receiver')
        message = data.get('message')
        is_system = data.get('is_system', False)  # Добавляем флаг системного сообщения
        
        if not receiver or not message:
            return jsonify({'error': 'Receiver and message are required'}), 400
        
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('INSERT INTO messages (sender, receiver, message, is_system) VALUES (?, ?, ?, ?)', 
                  (username, receiver, message, is_system))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Message sent successfully'}), 201
    except Exception as e:
        print(f"Send message error: {e}")
        return jsonify({'error': 'Server error while sending message'}), 500

@app.route('/recovery', methods=['GET'])
def recovery_page():
    if check_auth(request.cookies):
        return redirect('/main')
    recovery_id = request.args.get('id')
    if recovery_id:
        try:
            conn = sqlite3.connect('database.db')
            c = conn.cursor()
            c.execute('SELECT username FROM recovery WHERE recovery_id = ? AND expires_at > ?', 
                      (recovery_id, datetime.now()))
            recovery = c.fetchone()
            conn.close()
            if not recovery:
                return render_template('error.html', message='Invalid or expired recovery link'), 400
            return render_template('recovery_form.html', recovery_id=recovery_id)
        except Exception as e:
            print(f"Recovery form error: {e}")
            return render_template('error.html', message='Server error'), 500
    return render_template('recovery.html')

@app.route('/recovery', methods=['POST'])
def request_recovery():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
        email = data.get('email')
        if not email:
            return jsonify({'error': 'Email is required'}), 400
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username FROM users WHERE email = ?', (email,))
        user = c.fetchone()
        if not user:
            conn.close()
            return jsonify({'error': 'Email not found'}), 404
        username = user[0]
        recovery_id = str(uuid.uuid4())
        expires_at = datetime.now() + timedelta(hours=1)
        c.execute('INSERT INTO recovery (username, recovery_id, expires_at) VALUES (?, ?, ?)', 
                  (username, recovery_id, expires_at))
        conn.commit()
        conn.close()
        if send_recovery_email(email, username, recovery_id):
            return jsonify({'message': 'Recovery email sent'}), 200
        return jsonify({'error': 'Failed to send recovery email'}), 500
    except Exception as e:
        print(f"Recovery request error: {e}")
        return jsonify({'error': 'Server error during recovery request'}), 500

@app.route('/recovery/check', methods=['GET'])
def check_recovery_id():
    recovery_id = request.args.get('id')
    if not recovery_id:
        return jsonify({'error': 'Recovery ID is required'}), 400
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username, expires_at FROM recovery WHERE recovery_id = ?', 
                  (recovery_id,))
        recovery = c.fetchone()
        if not recovery:
            conn.close()
            return jsonify({'error': 'Invalid recovery ID'}), 404
        username, expires_at = recovery
        print(f"Retrieved expires_at: {expires_at}")  # Логирование для отладки
        try:
            # Попробуем разобрать expires_at как ISO 8601
            expires_at_dt = datetime.fromisoformat(expires_at.replace(' ', 'T'))
        except ValueError as ve:
            print(f"Date parsing error: {ve}, trying alternative format")
            # Альтернативный формат: 'YYYY-MM-DD HH:MM:SS'
            expires_at_dt = datetime.strptime(expires_at, '%Y-%m-%d %H:%M:%S')
        if expires_at_dt < datetime.now():
            conn.close()
            return jsonify({'error': 'Recovery link has expired'}), 400
        c.execute('SELECT username, password FROM users WHERE username = ?', (username,))
        user = c.fetchone()
        conn.close()
        if not user:
            return jsonify({'error': 'User not found'}), 404
        stored_username, stored_password = user
        # Преобразуем bytes в str
        password_str = stored_password.decode('utf-8') if isinstance(stored_password, bytes) else stored_password
        return jsonify({
            'username': stored_username,
            'password': password_str,
            'expires_at': expires_at_dt.isoformat()
        }), 200
    except Exception as e:
        print(f"Check recovery ID error: {str(e)}")
        conn.close()
        return jsonify({'error': f'Server error during recovery ID check: {str(e)}'}), 500

@app.route('/recovery', methods=['POST'])
def recover_account():
    recovery_id = request.args.get('id')
    if not recovery_id:
        return jsonify({'error': 'Recovery ID is required'}), 400
    try:
        conn = sqlite3.connect('database.db')
        c = conn.cursor()
        c.execute('SELECT username FROM recovery WHERE recovery_id = ? AND expires_at > ?', 
                  (recovery_id, datetime.now()))
        recovery = c.fetchone()
        if not recovery:
            conn.close()
            return jsonify({'error': 'Invalid or expired recovery link'}), 400
        username = recovery[0]
        c.execute('SELECT username, password FROM users WHERE username = ?', (username,))
        user = c.fetchone()
        conn.close()
        if not user:
            return jsonify({'error': 'User not found'}), 404
        stored_username, stored_password = user
        # Преобразуем bytes в str
        password_str = stored_password.decode('utf-8') if isinstance(stored_password, bytes) else stored_password
        return jsonify({'username': stored_username, 'password': password_str}), 200
    except Exception as e:
        print(f"Recover account error: {e}")
        conn.close()
        return jsonify({'error': 'Server error during account recovery'}), 500
    
def get_current_user():
    return check_auth(request.cookies)

@app.route('/call')
def call():
    username = check_auth(request.cookies)
    if not username:
        return render_template('index.html')
    return render_template('call.html')

def save_offer(call_id, offer):
    print(f"Saving offer for call_id {call_id}: {offer}")
    call_data[call_id] = call_data.get(call_id, {})
    call_data[call_id]['offer'] = offer
    call_data[call_id]['timestamp'] = time.time()

def save_answer(call_id, answer):
    print(f"Saving answer for call_id {call_id}: {answer}")
    call_data[call_id] = call_data.get(call_id, {})
    call_data[call_id]['answer'] = answer
    call_data[call_id]['timestamp'] = time.time()

def get_sdp(call_id):
    sdp = call_data.get(call_id, {})
    print(f"Returning SDP for call_id {call_id}: {sdp}")
    return sdp

def save_ice_candidate(call_id, candidate):
    print(f"Saving ICE candidate for call_id {call_id}: {candidate}")
    call_data[call_id] = call_data.get(call_id, {})
    call_data[call_id].setdefault('ice_candidates', []).append(candidate)
    call_data[call_id]['timestamp'] = time.time()

def get_ice_candidates(call_id):
    candidates = call_data.get(call_id, {}).get('ice_candidates', [])
    print(f"Returning ICE candidates for call_id {call_id}: {candidates}")
    return candidates

@app.route('/record/download/', methods=['GET'])
def download_recording(filename):
    username = check_auth(request.cookies)
    if not username:
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], secure_filename(filename))
        if not os.path.exists(file_path):
            return jsonify({'error': 'File not found'}), 404
        
        return send_file(file_path, mimetype='video/webm', as_attachment=False)
    except Exception as e:
        print(f"Download recording error: {e}")
        return jsonify({'error': 'Server error during file download'}), 500

init_db()
