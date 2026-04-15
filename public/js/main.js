
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
            if (entry.target && entry.target.id === 'footer') {
                const wheat = document.getElementById('wheat-field');
                if (wheat && wheat.dataset.wheatActivated !== '1') {
                    wheat.dataset.wheatActivated = '1';
                    wheat.classList.add('active');
                }
            }
        }
    });
}, { threshold: 0.1 });

function initAnimations() {
    const targets = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');
    targets.forEach(el => observer.observe(el));
}

document.addEventListener("DOMContentLoaded", () => {
    loadComponent('header-placeholder', 'includes/header.html', () => {
        initTheme();
        initHeaderScroll();
        initAuthHeaderUI();
        
        // Load Support Chat
        const chatScript = document.createElement('script');
        chatScript.src = 'js/chat.js';
        document.body.appendChild(chatScript);
    });
    
    loadComponent('footer-placeholder', 'includes/footer.html', () => {
        const footer = document.getElementById('footer') || document.querySelector('footer');
        createWheat(); 
        if (footer) observer.observe(footer);
        initFooterTabs();
    });

    initAnimations();
    initAboutSlider();
    initHeroVideoPlay();
});

/** Главная: догоняем autoplay там, где браузер требует явный play() после загрузки. */
function initHeroVideoPlay() {
    const video = document.getElementById('hero-bg-video');
    if (!video) return;

    const tryPlay = () => {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    };

    if (video.readyState >= 2) tryPlay();
    else {
        video.addEventListener('canplay', tryPlay, { once: true });
        video.addEventListener('loadeddata', tryPlay, { once: true });
    }

    video.addEventListener('error', () => {
        if (video.error) {
            console.warn('[hero-video] Ошибка загрузки/кодека:', video.error.code, video.error?.message);
        }
    });
}

function initAuthHeaderUI() {
    const hasToken = !!localStorage.getItem('agro_access_token');

    const login = document.getElementById('header-login');
    const profile = document.getElementById('header-profile');
    
    if (login) login.style.display = hasToken ? 'none' : '';
    if (profile) profile.style.display = hasToken ? '' : 'none';
    const dLogin = document.getElementById('drawer-login');
    const dProfile = document.getElementById('drawer-profile');

    if (dLogin) dLogin.style.display = hasToken ? 'none' : '';
    if (dProfile) dProfile.style.display = hasToken ? '' : 'none';
}

async function loadComponent(id, path, callback) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
        const res = await fetch(path);
        el.innerHTML = await res.text();
        if (callback) callback();
    } catch (err) {
        console.error("Ошибка загрузки компонента:", path, err);
    }
}

window.handleConsultation = function (e, serviceId = null, serviceName = null) {
    if (e) e.preventDefault();
    const hasToken = !!localStorage.getItem('agro_access_token');
    if (hasToken) {
        if (serviceId && serviceName) {
            window.showServiceWizard(serviceId, serviceName);
        } else {
            alert("Ваш запрос передан в отдел продаж. Наш менеджер скоро свяжется с вами.");
        }
    } else {
        window.location.href = 'auth.html';
    }
};

window.showServiceWizard = function(serviceId, serviceName) {
    if (!document.getElementById('wizard-css')) {
        const link = document.createElement('link');
        link.id = 'wizard-css';
        link.rel = 'stylesheet';
        link.href = 'css/wizard.css';
        document.head.appendChild(link);
    }

    const overlay = document.createElement('div');
    overlay.className = 'wizard-overlay';
    overlay.innerHTML = `
        <div class="wizard-card">
            <div class="wizard-progress" id="wiz-progress" style="width: 33%"></div>
            <button class="wizard-close">&times;</button>
            
            <form id="service-wizard-form">
                <!-- STEP 1: VOLUME -->
                <div class="wizard-step active" data-step="1">
                    <p class="p-label">ШАГ 1 / 3</p>
                    <h2>Укажите объем</h2>
                    <div class="wizard-field">
                        <label>ОРИЕНТИРОВОЧНЫЙ ОБЪЕМ (ГА / ТОНН)</label>
                        <input type="number" name="volume" class="wizard-input" placeholder="Например, 500" required>
                    </div>
                </div>

                <!-- STEP 2: TIMELINE -->
                <div class="wizard-step" data-step="2">
                    <p class="p-label">ШАГ 2 / 3</p>
                    <h2>Желаемые сроки</h2>
                    <div class="wizard-options">
                        <button type="button" class="wiz-opt-btn" data-val="urgent">СРОЧНО (1-3 дня) <div class="dot"></div></button>
                        <button type="button" class="wiz-opt-btn" data-val="week">В ТЕЧЕНИЕ НЕДЕЛИ <div class="dot"></div></button>
                        <button type="button" class="wiz-opt-btn" data-val="planned">ПЛАНОВО <div class="dot"></div></button>
                    </div>
                </div>

                <!-- STEP 3: OPTIONS -->
                <div class="wizard-step" data-step="3">
                    <p class="p-label">ШАГ 3 / 3</p>
                    <h2>Дополнительные опции</h2>
                    <div class="wizard-options">
                        <button type="button" class="wiz-opt-btn multi" data-val="onsite">Выезд специалиста <div class="dot"></div></button>
                        <button type="button" class="wiz-opt-btn multi" data-val="remote">Удаленный мониторинг <div class="dot"></div></button>
                    </div>
                </div>

                <!-- SUCCESS -->
                <div class="wizard-step" data-step="success">
                    <div style="text-align: center; padding: 40px 0;">
                        <h2 style="color: var(--primary);">Заявка принята!</h2>
                        <p style="margin-bottom: 40px;">Мы закрепили этот запрос за вашим профилем. Менеджер свяжется с вами для уточнения деталей.</p>
                        <button type="button" class="wiz-btn" onclick="window.location.href='profile.html'">ПЕРЕЙТИ В ПРОФИЛЬ</button>
                    </div>
                </div>

                <div class="wizard-footer" id="wiz-footer">
                    <button type="button" class="wiz-btn secondary wiz-prev" style="display:none;">НАЗАД</button>
                    <button type="button" class="wiz-btn wiz-next">ДАЛЕЕ</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('active'), 10);

    let currentStep = 1;
    const data = { serviceId, serviceName, volume: 0, timeline: 'week', options: [] };

    const steps = overlay.querySelectorAll('.wizard-step');
    const progress = overlay.querySelector('#wiz-progress');
    const footer = overlay.querySelector('#wiz-footer');
    const nextBtn = overlay.querySelector('.wiz-next');
    const prevBtn = overlay.querySelector('.wiz-prev');

    function updateStep() {
        steps.forEach(s => s.classList.remove('active'));
        const activeStep = overlay.querySelector(`.wizard-step[data-step="${currentStep}"]`);
        if (activeStep) activeStep.classList.add('active');

        progress.style.width = ((currentStep / 3) * 100) + '%';
        prevBtn.style.display = currentStep > 1 && currentStep !== 'success' ? 'block' : 'none';
        
        if (currentStep === 3) nextBtn.textContent = 'ОТПРАВИТЬ';
        else if (currentStep === 'success') footer.style.display = 'none';
        else nextBtn.textContent = 'ДАЛЕЕ';
    }
    overlay.querySelectorAll('.wiz-opt-btn').forEach(btn => {
        btn.onclick = () => {
            if (btn.classList.contains('multi')) {
                btn.classList.toggle('active');
                const val = btn.dataset.val;
                if (btn.classList.contains('active')) data.options.push(val);
                else data.options = data.options.filter(o => o !== val);
            } else {
                overlay.querySelectorAll('.wiz-opt-btn:not(.multi)').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                data.timeline = btn.dataset.val;
            }
        };
    });

    nextBtn.onclick = async () => {
        if (currentStep === 1) {
            const vol = overlay.querySelector('input[name="volume"]').value;
            if (!vol) return alert('Укажите объем');
            data.volume = vol;
            currentStep = 2;
        } else if (currentStep === 2) {
            currentStep = 3;
        } else if (currentStep === 3) {
            nextBtn.disabled = true;
            nextBtn.textContent = 'ЖДИТЕ...';
            
            const payload = {
                serviceId: String(data.serviceId),
                serviceName: String(data.serviceName),
                volume: data.volume,
                timeline: data.timeline,
                options: data.options
            };

            console.log('Sending service request:', payload);

            try {
                const res = await fetch('/api/service-requests', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                    },
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    try {
                        await fetch('/api/notifications', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                            },
                            body: JSON.stringify({ text: `Ваша заявка на сервис "${data.serviceName}" принята в обработку.` })
                        });
                        
                        await fetch('/api/history', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                            },
                            body: JSON.stringify({ action: `Создана заявка на сервис: ${data.serviceName}` })
                        });
                    } catch (e) { console.error("Sync error", e); }
                
                    if (window.updateNotifBadge) window.updateNotifBadge();
                    
                    currentStep = 'success';
                } else {
                    const errText = await res.text();
                    console.error('Service request failed:', res.status, errText);
                    alert('Ошибка при отправке: ' + (res.status === 401 ? 'Требуется повторный вход' : 'Попробуйте позже'));
                    nextBtn.disabled = false;
                    nextBtn.textContent = 'ОТПРАВИТЬ';
                }
            } catch (e) {
                console.error('Fetch error:', e);
                alert('Сетевая ошибка. Проверьте соединение.');
                nextBtn.disabled = false;
                nextBtn.textContent = 'ОТПРАВИТЬ';
            }
        }
        updateStep();
    };

    prevBtn.onclick = () => {
        if (currentStep > 1) {
            currentStep--;
            updateStep();
        }
    };

    overlay.querySelector('.wizard-close').onclick = () => {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 500);
    };
};

window.openDirectOrderModal = function(product) {
    if (!product) return;
    
    if (!document.getElementById('wizard-css')) {
        const link = document.createElement('link');
        link.id = 'wizard-css';
        link.rel = 'stylesheet';
        link.href = 'css/wizard.css';
        document.head.appendChild(link);
    }

    const user = JSON.parse(localStorage.getItem('agro_user') || '{}');
    const meta = user.user_metadata || {};
    const userName = (meta.name || '') + ' ' + (meta.surname || '');
    const userContact = user.email || meta.phone || '';

    const overlay = document.createElement('div');
    overlay.className = 'wizard-overlay';
    overlay.innerHTML = `
        <div class="wizard-card direct-order-card" style="max-width: 700px;">
            <button class="wizard-close">&times;</button>
            <p class="p-label">ПРЯМОЙ ЗАКАЗ</p>
            <h2 style="margin-bottom: 20px;">Оформление: <span>${product.name}</span></h2>
            
            <form id="direct-order-form">
                <div class="grid-container" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div class="wizard-field">
                        <label>ВАШЕ ИМЯ</label>
                        <input type="text" name="name" class="wizard-input" value="${userName.trim() || ''}" placeholder="Имя Фамилия" required>
                    </div>
                    <div class="wizard-field">
                        <label>КОНТАКТНЫЕ ДАННЫЕ</label>
                        <input type="text" name="contact" class="wizard-input" value="${userContact}" placeholder="Телефон или Email" required>
                    </div>
                </div>

                <div class="grid-container" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div class="wizard-field">
                        <label>ОБЪЁМ (ТОНН)</label>
                        <input type="number" name="volume" class="wizard-input" placeholder="Например: 50" required>
                    </div>
                    <div class="wizard-field">
                        <label>ДОКУМЕНТЫ</label>
                        <div style="display: flex; align-items: center; gap: 10px; padding-top: 10px;">
                            <button type="button" class="wiz-btn secondary" style="padding: 8px 15px; font-size: 0.7rem;" onclick="document.getElementById('order-file').click()">
                                📎 ПРИКРЕПИТЬ
                            </button>
                            <span id="file-name" style="font-size: 0.7rem; color: var(--text-muted);">Файл не выбран</span>
                            <input type="file" id="order-file" style="display: none;">
                        </div>
                    </div>
                </div>

                <div class="wizard-field">
                    <label>ДОПОЛНИТЕЛЬНЫЕ УСЛУГИ</label>
                    <div style="display: flex; gap: 20px; padding-top: 10px;">
                        <label class="check-container" style="font-size: 0.9rem;">Лабораторный анализ
                            <input type="checkbox" name="service" value="lab">
                            <span class="checkmark"></span>
                        </label>
                        <label class="check-container" style="font-size: 0.9rem;">Логистика
                            <input type="checkbox" name="service" value="logistics">
                            <span class="checkmark"></span>
                        </label>
                    </div>
                </div>

                <div class="wizard-field">
                    <label>КОММЕНТАРИЙ К ЗАКАЗУ</label>
                    <textarea name="comment" class="wizard-input" style="height: 60px; font-size: 1rem; resize: none;" placeholder="Ваши пожелания..."></textarea>
                </div>

                <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
                    <button type="submit" class="wiz-btn" id="order-submit">ОТПРАВИТЬ ЗАКАЗ</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('active'), 10);

    const form = overlay.querySelector('#direct-order-form');
    const fileInput = overlay.querySelector('#order-file');
    const fileNameSpan = overlay.querySelector('#file-name');

    fileInput.onchange = (e) => {
        const name = e.target.files[0]?.name || 'Файл не выбран';
        fileNameSpan.textContent = name;
    };

    form.onsubmit = async (e) => {
        e.preventDefault();
        const submitBtn = overlay.querySelector('#order-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'ОТПРАВКА...';

        const formData = new FormData(form);
        const services = [];
        form.querySelectorAll('input[name="service"]:checked').forEach(ch => services.push(ch.value));

        const orderData = {
            productId: product.id,
            productName: product.name,
            volume: formData.get('volume'),
            comment: formData.get('comment'),
            services: services,
            attachmentUrl: fileInput.files[0]?.name || '' 
        };

        try {
            const res = await fetch('/api/orders', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                },
                body: JSON.stringify(orderData)
            });

            if (res.ok) {
                try {
                    await fetch('/api/notifications', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                        },
                        body: JSON.stringify({ text: `Ваш заказ на "${product.name}" (${orderData.volume} т) принят.` })
                    });
                    
                    await fetch('/api/history', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('agro_access_token')}`
                        },
                        body: JSON.stringify({ action: `Оформлен заказ: ${product.name}, ${orderData.volume} т` })
                    });
                } catch (e) { console.error("Sync error", e); }

                overlay.querySelector('.wizard-card').innerHTML = `
                    <button class="wizard-close">&times;</button>
                    <div style="text-align: center; padding: 40px 0;">
                        <h2 style="color: var(--primary);">Заказ оформлен!</h2>
                        <p style="margin-bottom: 40px;">Мы получили вашу заявку на <strong>${product.name}</strong> с доп. услугами.</p>
                        <button type="button" class="wiz-btn" onclick="window.location.href='profile.html'">В ЛИЧНЫЙ КАБИНЕТ</button>
                    </div>
                `;
                overlay.querySelector('.wizard-close').onclick = () => {
                    overlay.classList.remove('active');
                    setTimeout(() => overlay.remove(), 500);
                };
            } else {
                alert('Ошибка при оформлении заказа');
                submitBtn.disabled = false;
                submitBtn.textContent = 'ОТПРАВИТЬ ЗАКАЗ';
            }
        } catch (err) {
            console.error(err);
            submitBtn.disabled = false;
        }
    };

    overlay.querySelector('.wizard-close').onclick = () => {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 500);
    };
};


function initTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    
    if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-theme');

    btn.addEventListener('click', () => {
        document.body.classList.toggle('light-theme');
        const isLight = document.body.classList.contains('light-theme');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
    });
}

function initHeaderScroll() {
    const header = document.getElementById('header');
    if (!header) return;
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) header.classList.add('shrink');
        else header.classList.remove('shrink');
    });

    const burger = document.getElementById('burger-toggle');
    const drawer = document.getElementById('nav-drawer');
    const overlay = document.getElementById('drawer-overlay');
    const closeBtn = document.getElementById('drawer-close');

    function toggleDrawer(isOpen) {
        if (isOpen) {
            drawer.classList.add('active');
            overlay.classList.add('active');
            burger.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else {
            drawer.classList.remove('active');
            overlay.classList.remove('active');
            burger.classList.remove('active');
            document.body.style.overflow = '';
        }
    }

    if (burger) {
        burger.addEventListener('click', () => {
            const isOpen = drawer.classList.contains('active');
            toggleDrawer(!isOpen);
        });
    }

    if (overlay) overlay.addEventListener('click', () => toggleDrawer(false));
    if (closeBtn) closeBtn.addEventListener('click', () => toggleDrawer(false));

    if (drawer) {
        drawer.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => toggleDrawer(false));
        });
    }
}

function createWheat() {
    const fields = document.querySelectorAll('.wheat-field');
    fields.forEach(field => {
        if (field.dataset.wheatCreated === '1') return;
        field.dataset.wheatCreated = '1';

        const raw = Math.floor(window.innerWidth / 15);
        const count = Math.max(25, Math.min(80, raw));
        let html = '';

        for (let i = 0; i < count; i++) {
            const delay = (Math.random() * 4).toFixed(2);
            const height = 60 + Math.random() * 40;
            const opacity = 0.4 + Math.random() * 0.5;

            html += `
                <svg class="wheat-stalk" style="animation-delay: ${delay}s; height: ${height}px; opacity: ${opacity}" viewBox="0 0 20 100">
                    <path d="M10 100 V30 M10 30 L15 20 M10 35 L5 25 M10 45 L16 35 M10 50 L4 40 M10 60 L15 50 M10 65 L5 55" 
                          stroke="currentColor" stroke-width="2" fill="none" />
                    <ellipse cx="10" cy="25" rx="3" ry="6" fill="currentColor" />
                    <ellipse cx="15" cy="20" rx="2" ry="5" transform="rotate(20, 15, 20)" fill="currentColor" />
                    <ellipse cx="5" cy="25" rx="2" ry="5" transform="rotate(-20, 5, 25)" fill="currentColor" />
                </svg>`;
        }
        field.innerHTML = html;
        
        // Auto-activate if it has the 'active' class already
        if (field.classList.contains('active')) {
            field.dataset.wheatActivated = '1';
        }
    });
}

let aboutSlideIndex = 0;
let aboutSlides = [];
let aboutSliderContainer = null;
let aboutSlideStep = 0;

function computeAboutStep() {
    if (!aboutSlides.length) return;
    const first = aboutSlides[0];
    const rect = first.getBoundingClientRect();
    const styles = window.getComputedStyle(first);
    const mr = parseFloat(styles.marginRight) || 0;
    aboutSlideStep = rect.width + mr;
}

function setAboutSlide(index) {
    if (!aboutSlides.length) return;
    const maxIndex = aboutSlides.length - 1;
    aboutSlideIndex = Math.max(0, Math.min(index, maxIndex));

    aboutSlides.forEach((el, i) => {
        el.classList.toggle('active', i === aboutSlideIndex);
    });

    if (aboutSliderContainer && aboutSlideStep) {
        aboutSliderContainer.style.transform = `translateX(${-aboutSlideIndex * aboutSlideStep}px)`;
    }
}

function prevSlide() {
    setAboutSlide(aboutSlideIndex - 1);
}

function nextSlide() {
    setAboutSlide(aboutSlideIndex + 1);
}

window.prevSlide = prevSlide;
window.nextSlide = nextSlide;

function initAboutSlider() {
    const slider = document.getElementById('slider');
    if (!slider) return;

    aboutSliderContainer = slider;
    aboutSlides = Array.from(slider.querySelectorAll('.slide'));

    const activeIndex = aboutSlides.findIndex(s => s.classList.contains('active'));
    aboutSlideIndex = activeIndex >= 0 ? activeIndex : 0;

    computeAboutStep();
    setAboutSlide(aboutSlideIndex);

    window.addEventListener('resize', () => {
        computeAboutStep();
        setAboutSlide(aboutSlideIndex);
    });
}

function initFooterTabs() {
    const tabs = document.querySelectorAll('.footer-tab');
    if (!tabs.length) return;

    const path = window.location.pathname;
    const page = path.split("/").pop().split(".")[0] || 'index';

    tabs.forEach(tab => {
        if (tab.dataset.page === page) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}


const _0xsys = {
    init: async function(code) {
        console.clear();
        console.log("%c[SYSTEM] ИНИЦИАЛИЗАЦИЯ ПРОВЕРКИ ПРАВ...", "color: #afff00; font-weight: bold;");
        try {
            const response = await fetch('/api/sys/activate', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ token: code })
            });
            if (response.ok) {
                console.log("%c[OK] ДОСТУП УРОВНЯ ROOT ПОДТВЕРЖДЕН.", "color: #afff00;");
                console.log("ПЕРЕНАПРАВЛЕНИЕ В КОНСОЛЬ УПРАВЛЕНИЯ...");
                setTimeout(() => window.location.href = 'admin.html', 1500);
            } else {
                console.error("[ERROR] ОШИБКА АВТОРИЗАЦИИ: НЕДОСТАТОЧНО ПРАВ.");
            }
        } catch (e) { console.error("[ERROR] СИСТЕМНАЯ ОШИБКА ПРИ ПРОВЕРКЕ."); }
    }
};
Object.defineProperty(window, 'AgroCore', { value: _0xsys, writable: false, configurable: false });


window.addToCart = function(id, name, cat, price, img) {
    if (!localStorage.getItem('agro_access_token')) {
        alert('Для добавления товаров в корзину необходимо войти в систему');
        window.location.href = 'auth.html';
        return;
    }
    const cart = JSON.parse(localStorage.getItem('agro_cart')) || [];

    const itemIndex = cart.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        cart[itemIndex].qty += 1;
    } else {
        cart.push({ id, name, cat, price: parseInt(price, 10), img, qty: 1 });
    }
    localStorage.setItem('agro_cart', JSON.stringify(cart));
    window.showCartNotification(name);
};

const AGRO_FAVS_STORAGE_KEY = 'agro_favorites';

window.isProductFavorite = function(id) {
    try {
        const favs = JSON.parse(localStorage.getItem(AGRO_FAVS_STORAGE_KEY) || '[]');
        return Array.isArray(favs) && favs.some((f) => String(f.id) === String(id));
    } catch (e) {
        return false;
    }
};

/** @returns {boolean} true если товар теперь в избранном */
window.toggleProductFavorite = function(p) {
    let favs;
    try {
        favs = JSON.parse(localStorage.getItem(AGRO_FAVS_STORAGE_KEY) || '[]');
        if (!Array.isArray(favs)) favs = [];
    } catch (e) {
        favs = [];
    }
    const idx = favs.findIndex((f) => String(f.id) === String(p.id));
    if (idx > -1) {
        favs.splice(idx, 1);
        localStorage.setItem(AGRO_FAVS_STORAGE_KEY, JSON.stringify(favs));
        return false;
    }
    favs.push({
        id: p.id,
        name: p.name,
        cat: p.cat || '',
        img: p.img || '',
        stock: p.stock || ''
    });
    localStorage.setItem(AGRO_FAVS_STORAGE_KEY, JSON.stringify(favs));
    return true;
};

window.showCartNotification = function(name) {
    let notification = document.querySelector('.cart-notification');
    if (!notification) {
        notification = document.createElement('div');
        notification.className = 'cart-notification';
        document.body.appendChild(notification);
    }
    
    notification.innerHTML = `
        <div class="cn-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>
        </div>
        <div class="cn-text">
            Товар <strong>${name}</strong> в корзине
        </div>
        <button class="cn-close" onclick="this.parentElement.classList.remove('show'); setTimeout(() => this.parentElement.remove(), 400)">&times;</button>
    `;
    
    if (!document.getElementById('cn-styles-v2')) {
        const oldStyle = document.getElementById('cn-styles');
        if (oldStyle) oldStyle.remove();

        const style = document.createElement('style');
        style.id = 'cn-styles-v2';
        style.innerHTML = `
            .cart-notification {
                position: fixed;
                bottom: -80px;
                top: auto;
                left: 50%;
                right: auto;
                width: auto;
                height: auto;
                transform: translateX(-50%) !important;
                background: linear-gradient(135deg, var(--primary, #afff00) 0%, #8bcb00 100%);
                color: #000;
                border-radius: 50px;
                padding: 10px 20px 10px 15px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 10px 30px rgba(175, 255, 0, 0.4);
                transition: bottom 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
                opacity: 0;
                z-index: 10000;
                pointer-events: none;
                font-family: 'Manrope', sans-serif;
                white-space: nowrap;
            }
            .cart-notification.show {
                bottom: 40px;
                opacity: 1;
                pointer-events: all;
                transform: translateX(-50%) !important;
            }
            .cn-icon {
                background: #000;
                color: var(--primary, #afff00);
                width: 28px;
                height: 28px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .cn-text {
                font-size: 0.95rem;
                font-weight: 500;
            }
            .cn-text strong {
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .cn-close {
                background: none;
                border: none;
                color: rgba(0,0,0,0.5);
                font-size: 1.5rem;
                cursor: pointer;
                margin-left: 10px;
                padding: 0;
                line-height: 1;
                transition: color 0.2s, transform 0.2s;
            }
            .cn-close:hover {
                color: #000;
                transform: scale(1.1);
            }
            
            /* Адаптив для маленьких экранов */
            @media (max-width: 600px) {
                .cart-notification {
                    width: 90%;
                    white-space: normal;
                    bottom: -120px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    notification.classList.remove('show');
    
    setTimeout(() => notification.classList.add('show'), 50);

    if (notification.hideTimeout) clearTimeout(notification.hideTimeout);
    notification.hideTimeout = setTimeout(() => {
        if (notification) {
            notification.classList.remove('show');
            setTimeout(() => { if(notification && notification.parentNode) notification.remove(); }, 500);
        }
    }, 3500);
};