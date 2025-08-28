let selectedUser = null;
let messagePollingInterval = null;
let usersPollingInterval = null;
let peerConnection = null;
let callId = null;
let callCheckInterval = null;
let iceCandidatesBuffer = []; // Буфер для хранения ICE-кандидатов

async function initiateCall(receiver) {
    const response = await fetch('/call/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiver })
    });
    const result = await response.json();
    return result.call_id;
}

async function sendCallNotification(receiver, callId) {
    await fetch('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            receiver,
            content: `Incoming call: /call?user=${receiver}&call_id=${callId}`
        })
    });
}

async function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (callId) {
        await fetch('/call/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ call_id: callId })
        });
        callId = null;
    }
    if (callCheckInterval) {
        clearInterval(callCheckInterval);
        callCheckInterval = null;
    }
    document.getElementById('startCallButton').disabled = false;
    document.getElementById('endCallButton').disabled = true;
    document.getElementById('errorMessage').style.display = 'none';
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
}

async function playRecordedVideo(filename) {
    const remoteVideo = document.getElementById('remoteVideo');
    try {
        const response = await fetch(`/record/download/${filename}`, {
            method: 'GET',
            headers: { 'Accept': 'video/webm' }
        });
        if (!response.ok) {
            throw new Error('Failed to fetch recorded video');
        }
        const blob = await response.blob();
        const videoUrl = URL.createObjectURL(blob);
        remoteVideo.srcObject = null; // Clear any WebRTC stream
        remoteVideo.src = videoUrl; // Set the video source to the recorded file
        remoteVideo.play(); // Start playback
        console.log('Playing recorded video:', filename);
        showNotification('Playing recorded video');
    } catch (error) {
        console.error('Error playing recorded video:', error);
        showNotification('Error playing recorded video: ' + error.message, true);
    }
}

// Modify the startCall function to call playRecordedVideo after uploading
async function startCall() {
    const remoteUser = new URLSearchParams(window.location.search).get('user');
    const existingCallId = new URLSearchParams(window.location.search).get('call_id');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    const startCallButton = document.getElementById('startCallButton');
    const endCallButton = document.getElementById('endCallButton');
    let mediaRecorder;
    let recordedChunks = [];

    try {
        console.log('Starting call, remoteUser:', remoteUser, 'callId:', existingCallId);
        startCallButton.disabled = true;
        endCallButton.disabled = false;

        // Get user media
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log('Local stream acquired:', stream.getTracks());
        localVideo.srcObject = stream;

        await sendCallNotification(remoteUser, callId);

        // Initialize MediaRecorder
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                console.log('Recorded chunk added:', event.data);
            }
        };
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const filename = `recording-${callId || Date.now()}-${getCurrentUser()}.webm`;
            recordedChunks = [];

            // Upload the recording
            const formData = new FormData();
            formData.append('file', blob, filename);
            formData.append('call_id', callId || 'unknown');
            formData.append('user', getCurrentUser());

            try {
                const response = await fetch('/record/upload', {
                    method: 'POST',
                    body: formData,
                });
                const result = await response.json();
                console.log('Recording upload response:', result);
                showNotification(result.message || 'Recording uploaded successfully');

                // Play the uploaded video in remoteVideo
                await playRecordedVideo(filename);
            } catch (error) {
                console.error('Error uploading recording:', error);
                showNotification('Error uploading recording', true);
            }
        };

        mediaRecorder.start(1000);
        console.log('Recording started');

        // ... (rest of your WebRTC setup remains unchanged)

        // Example: If you want to play a specific recording manually, you can call:
        // playRecordedVideo('recording-<call_id>-<username>.webm');

    } catch (error) {
        console.error('Start call error:', error);
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
        document.getElementById('errorMessage').textContent = 'Error starting call: ' + error.message;
        document.getElementById('errorMessage').style.display = 'block';
        startCallButton.disabled = false;
        endCallButton.disabled = true;
        await endCall();
    }
}

async function startCallStatusCheck() {
    if (callCheckInterval) {
        clearInterval(callCheckInterval);
    }

    callCheckInterval = setInterval(async () => {
        if (!callId) return;

        try {
            const response = await fetch(`/call/check?id=${callId}`);
            if (!response.ok) return;

            const result = await response.json();
            console.log('Call status check:', result);
            if (result.status === 'accepted') {
                document.getElementById('errorMessage').style.display = 'none';
                if (!peerConnection.remoteDescription) {
                    console.log('Fetching answer for caller...');
                    const sdpResponse = await fetch(`/call/sdp?call_id=${callId}`);
                    const sdpData = await sdpResponse.json();
                    console.log('Received SDP answer:', sdpData);
                    if (sdpData.answer) {
                        console.log('Setting remote description (answer)...');
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpData.answer));
                        console.log('Processing buffered ICE candidates after setting answer...');
                        await processBufferedIceCandidates();
                    } else {
                        console.error('No answer found in SDP data');
                    }
                }
            } else if (result.status === 'ended') {
                console.log('Call ended by the other party');
                document.getElementById('errorMessage').textContent = 'Call ended by the other party';
                document.getElementById('errorMessage').style.display = 'block';
                await endCall();
            }
        } catch (error) {
            console.error('Call status check error:', error);
        }
    }, 2000);
}

async function processBufferedIceCandidates() {
    if (peerConnection.remoteDescription && iceCandidatesBuffer.length > 0) {
        console.log('Processing buffered ICE candidates:', iceCandidatesBuffer);
        for (const candidate of iceCandidatesBuffer) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('Added buffered ICE candidate:', candidate);
        }
        iceCandidatesBuffer = []; // Очищаем буфер после обработки
    }
}

// Show a styled notification
function showNotification(message, isError = false) {
    let notificationContainer = document.getElementById('notification-container');
    if (!notificationContainer) {
        notificationContainer = document.createElement('div');
        notificationContainer.id = 'notification-container';
        notificationContainer.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
        `;
        document.body.appendChild(notificationContainer);
    }
    const notification = document.createElement('div');
    notification.style.cssText = `
        background: ${isError ? '#ffebee' : '#e8f5e8'};
        border: 1px solid ${isError ? '#f44336' : '#4CAF50'};
        border-radius: 8px;
        padding: 16px;
        min-width: 300px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        animation: slideIn 0.3s ease;
    `;
    notification.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
            <div style="font-weight: bold; color: ${isError ? '#d32f2f' : '#2e7d32'};">
                ${isError ? '❌ Error' : '✅ Success'}
            </div>
            <button onclick="this.parentElement.parentElement.remove()"
                    style="background: none; border: none; font-size: 18px; cursor: pointer; color: #666;">
                ×
            </button>
        </div>
        <div style="margin-bottom: 15px; color: #333;">${message}</div>
        <button onclick="this.parentElement.parentElement.remove()"
                style="background-color: ${isError ? '#f44336' : '#4CAF50'};
                       color: white;
                       padding: 8px 16px;
                       border: none;
                       border-radius: 4px;
                       cursor: pointer;
                       width: 100%;
                       font-size: 14px;">
            OK
        </button>
    `;
    notificationContainer.appendChild(notification);
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
`;
document.head.appendChild(style);

// Escape HTML to prevent XSS
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Register a new user
async function register() {
    const usernameInput = document.getElementById('usernameInput');
    const passwordInput = document.getElementById('passwordInput');
    const emailInput = document.getElementById('emailInput');
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const email = emailInput.value.trim();
    if (!username || !password || !email) {
        showNotification('Please enter username, password, and email', true);
        return;
    }
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
        showNotification('Password must be at least 8 characters and include an uppercase letter, lowercase letter, number, and special character', true);
        return;
    }
    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Registration error', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        window.location.href = '/main';
    } catch (error) {
        console.error('Registration error:', error);
        showNotification('Error during registration: ' + error.message, true);
    }
}

// Log in a user
async function login() {
    const usernameInput = document.getElementById('usernameInput');
    const passwordInput = document.getElementById('passwordInput');
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (!username || !password) {
        showNotification('Please enter username and password', true);
        return;
    }
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Login error', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        window.location.href = '/main';
    } catch (error) {
        console.error('Login error:', error);
        showNotification('Error during login: ' + error.message, true);
    }
}

// Log out a user
async function logout() {
    try {
        const response = await fetch('/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Logout error', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        const result = await response.json();
        showNotification(result.message);
        setTimeout(() => {
            window.location.href = '/';
        }, 1000);
    } catch (error) {
        console.error('Logout error:', error);
        showNotification('Error during logout: ' + error.message, true);
    }
}

// Delete user account
async function deleteAccount() {
    try {
        const response = await fetch('/deleteacc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Account deletion error', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        const result = await response.json();
        showNotification(result.message);
        setTimeout(() => {
            window.location.href = '/';
        }, 1000);
    } catch (error) {
        console.error('Delete account error:', error);
        showNotification('Error deleting account: ' + error.message, true);
    }
}

// Request password recovery
async function requestRecovery() {
    const emailInput = document.getElementById('emailInput');
    const email = emailInput.value.trim();
    if (!email) {
        showNotification('Please enter your email', true);
        return;
    }
    try {
        const response = await fetch('/recovery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Recovery request error', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        showNotification('Recovery email sent. Check your inbox.');
    } catch (error) {
        console.error('Recovery request error:', error);
        showNotification('Error requesting recovery: ' + error.message, true);
    }
}

// Check recovery ID
async function checkRecoveryId(recoveryId) {
    try {
        const response = await fetch(`/recovery/check?id=${recoveryId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Invalid or expired recovery link', true);
                window.location.href = '/recovery';
                return null;
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
                window.location.href = '/recovery';
                return null;
            }
        }
        const result = await response.json();
        const expiresAt = new Date(result.expires_at);
        const now = new Date();
        if (expiresAt < now) {
            showNotification('Recovery link has expired', true);
            window.location.href = '/recovery';
            return null;
        }
        showNotification(`Your account details:\nUsername: ${result.username}\nPassword: ${result.password}`);
        setTimeout(() => {
            window.location.href = '/';
        }, 3000);
        return result;
    } catch (error) {
        console.error('Check recovery ID error:', error);
        showNotification('Error checking recovery ID: ' + error.message, true);
        window.location.href = '/recovery';
        return null;
    }
}

// Load users
async function loadUsers() {
    try {
        const response = await fetch('/users');
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Error loading users', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        const users = await response.json();
        const userList = document.getElementById('userList');
        const noUsers = document.getElementById('noUsers');
        const currentUsers = Array.from(userList.children).map(li => li.textContent);
        if (JSON.stringify(currentUsers) === JSON.stringify(users)) {
            return;
        }
        userList.innerHTML = '';
        if (users.length === 0) {
            noUsers.style.display = 'block';
        } else {
            noUsers.style.display = 'none';
            users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = user;
                li.onclick = () => selectUser(user);
                if (user === selectedUser) {
                    li.classList.add('active');
                }
                userList.appendChild(li);
            });
        }
    } catch (error) {
        console.error('Load users error:', error);
        showNotification('Error loading users: ' + error.message, true);
    }
}

// Select a user for chat
async function selectUser(user) {
    selectedUser = user;
    document.getElementById('chatHeader').textContent = `Chat with ${user}`;
    document.getElementById('messageInput').disabled = false;
    document.getElementById('sendButton').disabled = false;
    const userListItems = document.querySelectorAll('#userList li');
    userListItems.forEach(item => item.classList.remove('active'));
    event.target.classList.add('active');
    loadMessages();
    startMessagePolling();
}

// Load messages
async function loadMessages() {
    if (!selectedUser) return;
    try {
        const response = await fetch(`/messages?receiver=${selectedUser}`);
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Error loading messages', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        const messages = await response.json();
        const chatMessages = document.getElementById('chatMessages');
        const isScrolledToBottom = chatMessages.scrollHeight - chatMessages.clientHeight <= chatMessages.scrollTop + 1;

        chatMessages.innerHTML = '';
        messages.forEach(msg => {
            const div = document.createElement('div');
            div.className = `message ${msg.sender === getCurrentUser() ? 'sent' : 'received'} ${msg.is_system ? 'system' : ''}`;
            if (msg.is_system) {
                div.innerHTML = `
                    <div>${msg.message}</div>
                    <div class="timestamp">${new Date(msg.timestamp).toLocaleString()}</div>
                `;
            } else {
                div.innerHTML = `
                    <div>${escapeHtml(msg.message)}</div>
                    <div class="timestamp">${new Date(msg.timestamp).toLocaleString()}</div>
                `;
            }
            chatMessages.appendChild(div);
        });

        if (isScrolledToBottom) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    } catch (error) {
        console.error('Load messages error:', error);
        showNotification('Error loading messages: ' + error.message, true);
    }
}

// Send a message
async function sendMessage() {
    if (!selectedUser) return;
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const message = messageInput.value.trim();
    if (!message) {
        showNotification('Please enter a message', true);
        return;
    }
    try {
        messageInput.disabled = true;
        sendButton.disabled = true;
        const response = await fetch('/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receiver: selectedUser, message })
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Error sending message', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }
        messageInput.value = '';
        messageInput.focus();
        loadMessages();
    } catch (error) {
        console.error('Send message error:', error);
        showNotification('Error sending message: ' + error.message, true);
    } finally {
        messageInput.disabled = false;
        sendButton.disabled = false;
    }
}

// Start polling for new messages
function startMessagePolling() {
    if (messagePollingInterval) {
        clearInterval(messagePollingInterval);
    }
    messagePollingInterval = setInterval(() => {
        if (selectedUser) {
            loadMessages();
        }
    }, 3000);
}

// Stop polling for messages
function stopMessagePolling() {
    if (messagePollingInterval) {
        clearInterval(messagePollingInterval);
        messagePollingInterval = null;
    }
}

// Start polling for users
function startUsersPolling()

 {
    if (usersPollingInterval) {
        clearInterval(usersPollingInterval);
    }
    usersPollingInterval = setInterval(() => {
        loadUsers();
    }, 3000);
}

// Stop polling for users
function stopUsersPolling() {
    if (usersPollingInterval) {
        clearInterval(usersPollingInterval);
        usersPollingInterval = null;
    }
}

// Get current user from cookies
function getCurrentUser() {
    const cookies = document.cookie.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        acc[key] = value;
        return acc;
    }, {});
    return cookies.username;
}

// Decline an incoming call
async function declineCall(callId) {
    try {
        await fetch('/call/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ call_id: callId })
        });
        const notification = document.getElementById('incomingCallNotification');
        if (notification) notification.remove();
    } catch (error) {
        console.error('Decline call error:', error);
    }
}

// Check for incoming calls
async function checkForIncomingCalls() {
    try {
        const response = await fetch('/call/check');
        if (!response.ok) return;

        const result = await response.json();
        if (result.has_call) {
            showIncomingCallNotification(result.caller, result.call_id);
        }
    } catch (error) {
        console.error('Check for calls error:', error);
    }
}

// Show incoming call notification
function showIncomingCallNotification(caller, callId) {
    if (document.getElementById('incomingCallNotification')) return;

    const notification = document.createElement('div');
    notification.id = 'incomingCallNotification';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: white;
        padding: 20px;
        border-radius: 10px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        z-index: 1000;
        border: 2px solid #007bff;
    `;

    notification.innerHTML = `
        <h3>Incoming Call 📞</h3>
        <p>${caller} is calling you</p>
        <div style="display: flex; gap: 10px; margin-top: 10px;">
            <button onclick="acceptCall('${callId}')" style="background-color: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">Accept</button>
            <button onclick="declineCall('${callId}')" style="background-color: #f44336; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">Decline</button>
        </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        if (document.getElementById('incomingCallNotification')) {
            document.getElementById('incomingCallNotification').remove();
        }
    }, 30000);
}
// Accept an incoming call
async function acceptCall(callId) {
    try {
        const response = await fetch('/call/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ call_id: callId })
        });

        if (!response.ok) {
            const text = await response.text();
            try {
                const result = JSON.parse(text);
                showNotification(result.error || 'Error accepting call', true);
            } catch (e) {
                console.error('Non-JSON response:', text);
                showNotification('Server returned unexpected response', true);
            }
            return;
        }

        const result = await response.json();
        window.location.href = `/call?user=${encodeURIComponent(result.caller)}&call_id=${callId}`;
    } catch (error) {
        console.error('Accept call error:', error);
        showNotification('Error accepting call: ' + error.message, true);
    }
}
// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname === '/main') {
        loadUsers();
        startUsersPolling();
        setInterval(checkForIncomingCalls, 3000);
        const messageInput = document.getElementById('messageInput');
        if (messageInput) {
            messageInput.addEventListener('keypress', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                }
            });
        }
    } else if (window.location.pathname === '/recovery') {
        const urlParams = new URLSearchParams(window.location.search);
        const recoveryId = urlParams.get('id');
        if (recoveryId) {
            checkRecoveryId(recoveryId);
        } else {
            console.error('No recovery_id found in URL');
        }
    } else if (window.location.pathname === '/call') {
        const callId = new URLSearchParams(window.location.search).get('call_id');
        if (callId) {
            startCall(); // Auto-start call for called user
        }
    }
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopMessagePolling();
        stopUsersPolling();
    } else if (window.location.pathname === '/main') {
        startUsersPolling();
        if (selectedUser) {
            startMessagePolling();
        }
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopMessagePolling();
    stopUsersPolling();
});