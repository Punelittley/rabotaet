/**
 * Support Chat Component
 */
class SupportChat {
    constructor() {
        this.isOpen = false;
        this.sessionId = this.getSessionId();
        this.messages = [];
        this.lastSyncIso = '';
        this.pollTimer = null;
        this.init();
    }

    getSessionId() {
        const key = 'agro_support_session_id';
        let id = localStorage.getItem(key);
        if (!id) {
            id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            localStorage.setItem(key, id);
        }
        return id;
    }

    init() {
        this.injectStyles();
        this.createElements();
        this.bindEvents();
        this.loadInitialMessages();
        this.startPolling();
    }

    injectStyles() {
        if (!document.querySelector('link[href="css/chat.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'css/chat.css';
            document.head.appendChild(link);
        }
    }

    createElements() {
        const wrapper = document.createElement('div');
        wrapper.className = 'support-chat-wrapper';
        wrapper.innerHTML = `
            <div class="chat-window" id="support-chat-window">
                <div class="chat-header">
                    <div class="chat-title">
                        <div class="chat-title-text">
                            <h4>Поддержка</h4>
                        </div>
                    </div>
                    <button class="close-chat" id="close-chat-btn" aria-label="Закрыть чат">&times;</button>
                </div>
                <div class="chat-messages" id="chat-messages-container">
                    ${this.renderMessages()}
                </div>
                <form class="chat-input-area" id="chat-form">
                    <input type="text" class="chat-input" id="chat-input" placeholder="Введите сообщение..." required autocomplete="off">
                    <button type="submit" class="send-chat" id="send-chat-btn">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="5" y1="19" x2="19" y2="5"></line>
                            <polyline points="9 5 19 5 19 15"></polyline>
                        </svg>
                    </button>
                </form>
            </div>
        `;
        document.body.appendChild(wrapper);
        this.window = document.getElementById('support-chat-window');
        this.container = document.getElementById('chat-messages-container');
        this.input = document.getElementById('chat-input');
        this.form = document.getElementById('chat-form');
    }

    renderMessages() {
        if (!this.messages.length) {
            return `<div class="message support">Здравствуйте! Напишите ваш вопрос, и поддержка ответит здесь.<span class="message-time">сейчас</span></div>`;
        }
        return this.messages.map(msg => `
            <div class="message ${msg.role}">
                ${msg.text}
                <span class="message-time">${msg.time}</span>
            </div>
        `).join('');
    }

    addMessage(role, text, displayTime = null) {
        const time =
            displayTime ||
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.messages.push({ role, text, time });
        
        const msgEl = document.createElement('div');
        msgEl.className = `message ${role}`;
        msgEl.innerHTML = `${text}<span class="message-time">${time}</span>`;
        
        this.container.appendChild(msgEl);
        this.container.scrollTop = this.container.scrollHeight;

    }

    formatTime(isoString) {
        const d = new Date(isoString);
        if (Number.isNaN(d.getTime())) {
            return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async loadInitialMessages() {
        try {
            const res = await fetch(`/api/support/messages?sessionId=${encodeURIComponent(this.sessionId)}`);
            if (!res.ok) return;
            const data = await res.json();
            const list = Array.isArray(data.messages) ? data.messages : [];
            this.messages = list.map((m) => ({
                role: m.from === 'support' ? 'support' : 'user',
                text: m.text,
                time: this.formatTime(m.time),
            }));
            const last = list[list.length - 1];
            if (last?.time) this.lastSyncIso = last.time;
            this.container.innerHTML = this.renderMessages();
            this.container.scrollTop = this.container.scrollHeight;
        } catch (_) {}
    }

    async fetchNewMessages() {
        try {
            const params = new URLSearchParams({ sessionId: this.sessionId });
            if (this.lastSyncIso) params.set('since', this.lastSyncIso);
            const res = await fetch(`/api/support/messages?${params.toString()}`);
            if (!res.ok) return;
            const data = await res.json();
            const list = Array.isArray(data.messages) ? data.messages : [];
            if (!list.length) return;

            list.forEach((m) => {
                const role = m.from === 'support' ? 'support' : 'user';
                const t = this.formatTime(m.time);
                const dup = this.messages.some(
                    (x) => x.role === role && x.text === m.text && x.time === t
                );
                if (!dup) {
                    this.addMessage(role, m.text, t);
                }
                if (m.time) this.lastSyncIso = m.time;
            });
        } catch (_) {}
    }

    startPolling() {
        this.stopPolling();
        this.pollTimer = setInterval(() => this.fetchNewMessages(), 3000);
    }

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async sendMessage(text) {
        const userLabel = localStorage.getItem('agro_user_name') || 'Пользователь сайта';
        const res = await fetch('/api/support/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: this.sessionId,
                text,
                userLabel
            })
        });
        if (!res.ok) {
            throw new Error('send failed');
        }
        return res.json();
    }

    bindEvents() {
        document.addEventListener('click', (e) => {
            const supportLink = e.target.closest('#support-link') || e.target.closest('#drawer-support');
            if (supportLink) {
                e.preventDefault();
                this.toggle(true);
            }
        });

        document.getElementById('close-chat-btn').addEventListener('click', () => {
            this.toggle(false);
        });

        this.form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = this.input.value.trim();
            if (text) {
                try {
                    const data = await this.sendMessage(text);
                    const saved = data?.message;
                    if (saved?.time) {
                        this.lastSyncIso = saved.time;
                        this.addMessage('user', text, this.formatTime(saved.time));
                    } else {
                        this.addMessage('user', text);
                    }
                    this.input.value = '';
                } catch (_) {
                    this.addMessage('support', 'Не удалось отправить сообщение. Попробуйте еще раз.');
                }
            }
        });

        // Close on ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.toggle(false);
            }
        });
    }

    toggle(force) {
        this.isOpen = force !== undefined ? force : !this.isOpen;
        this.window.classList.toggle('active', this.isOpen);
        if (this.isOpen) {
            this.input.focus();
            this.container.scrollTop = this.container.scrollHeight;
        }
    }
}

// Initialize
const initSupportChat = () => {
    if (!window.SupportChatInstance) {
        window.SupportChatInstance = new SupportChat();
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupportChat);
} else {
    initSupportChat();
}
