
function openCPModal() {
    const modal = document.getElementById('cpModal');
    modal.style.display = '';
    setTimeout(() => modal.classList.add('active'), 10);
}

function closeCPModal() {
    const modal = document.getElementById('cpModal');
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 400);
}

function handleGenerateCP() {
    const clientName = document.getElementById('cpClientName').value.trim();
    const volume = document.getElementById('cpVolume').value.trim();
    if (!clientName) {
        alert('Пожалуйста, укажите ваше имя или название компании.');
        document.getElementById('cpClientName').focus();
        return;
    }
    if (!volume || Number(volume) <= 0) {
        alert('Пожалуйста, укажите объём (в тоннах).');
        document.getElementById('cpVolume').focus();
        return;
    }

    const product = window.currentProduct;
    if (!product) {
        alert('Ошибка: продукт не найден.');
        return;
    }

    generatePDF(product, clientName, volume);
}

function generatePDF(product, clientName, volume) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
    const cpNumber = 'КП-' + today.getFullYear() + '-' + String(Math.floor(Math.random() * 9000 + 1000));

    const price = product.id * 8500 % 60000 + 15000;
    const totalPrice = price * Number(volume);

    const specs = (product.specs || []).map(s => {
        const parts = String(s).split(':');
        const key = (parts[0] || '').trim();
        const val = parts.slice(1).join(':').trim() || key;
        return `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #e0e0e0; color: #555; font-size: 13px;">${key}</td><td style="padding: 8px 12px; border-bottom: 1px solid #e0e0e0; font-weight: 600; font-size: 13px;">${val}</td></tr>`;
    }).join('');

    const template = `
    <div id="cp-pdf-content" style="font-family: 'Segoe UI', Arial, sans-serif; color: #222; max-width: 800px; margin: 0 auto; padding: 40px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2e7d32; padding-bottom: 25px; margin-bottom: 30px;">
            <div>
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <img src="media/logo.svg" style="height: 50px;" alt="Лого">
                </div>
                <div style="font-size: 20px; font-weight: 700; color: #2e7d32; margin-bottom: 4px;">Зелёный край</div>
                <div style="font-size: 12px; color: #888;">Сельскохозяйственная продукция</div>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 22px; font-weight: 700; color: #2e7d32;">${cpNumber}</div>
                <div style="font-size: 12px; color: #888; margin-top: 4px;">от ${dateStr}</div>
            </div>
        </div>

        <!-- АДРЕСАТ -->
        <div style="background: #f5f9f5; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
            <div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Для</div>
            <div style="font-size: 16px; font-weight: 600;">${clientName}</div>
        </div>

        <!-- ПРОДУКТ -->
        <h2 style="font-size: 18px; color: #2e7d32; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">Коммерческое предложение</h2>

        <div style="display: flex; gap: 20px; margin-bottom: 30px;">
            <div style="flex: 1;">
                <h3 style="font-size: 16px; margin-bottom: 12px;">${product.name}</h3>
                <p style="font-size: 13px; color: #666; line-height: 1.6;">${product.fullDesc || 'Высококачественное сырьё, прошедшее многоуровневую очистку и калибровку.'}</p>
            </div>
            ${product.img ? `<img src="${product.img}" style="width: 150px; height: 100px; object-fit: cover; border-radius: 4px; border: 1px solid #ddd;" alt="">` : ''}
        </div>

        <!-- СПЕЦИФИКАЦИЯ -->
        ${specs ? `
        <h3 style="font-size: 14px; color: #2e7d32; margin-bottom: 10px;">Показатели качества</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
            ${specs}
        </table>` : ''}

        <!-- РАСЧЁТ СТОИМОСТИ -->
        <div style="background: #f5f9f5; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
            <h3 style="font-size: 14px; color: #2e7d32; margin-bottom: 15px;">Расчёт стоимости</h3>
            <table style="width: 100%; border-collapse: collapse;">
                <tr>
                    <td style="padding: 8px 0; color: #555; font-size: 13px;">Цена за тонну</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: 600; font-size: 13px;">${price.toLocaleString('ru-RU')} ₽</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #555; font-size: 13px;">Объём</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: 600; font-size: 13px;">${volume} т</td>
                </tr>
                <tr style="border-top: 2px solid #2e7d32;">
                    <td style="padding: 12px 0; font-weight: 700; font-size: 15px;">Итого</td>
                    <td style="padding: 12px 0; text-align: right; font-weight: 700; font-size: 15px; color: #2e7d32;">${totalPrice.toLocaleString('ru-RU')} ₽</td>
                </tr>
            </table>
        </div>

        <!-- УСЛОВИЯ -->
        <div style="margin-bottom: 30px;">
            <h3 style="font-size: 14px; color: #2e7d32; margin-bottom: 10px;">Условия поставки</h3>
            <ul style="font-size: 13px; color: #555; line-height: 2; padding-left: 20px;">
                <li>Условия оплаты: предоплата 50%, остаток по факту отгрузки</li>
                <li>Срок поставки: 5–10 рабочих дней</li>
                <li>Валидность предложения: 14 календарных дней</li>
                <li>Минимальный объём заказа: от 20 тонн</li>
            </ul>
        </div>

        <!-- ПОДВАЛ -->
        <div style="border-top: 2px solid #2e7d32; padding-top: 20px; margin-top: 30px;">
            <div style="display: flex; justify-content: space-between; font-size: 12px; color: #888;">
                <div>
                    <strong style="color: #222;">ООО «Зелёный край»</strong><br>
                    Оренбургская область, село Асекеево<br>
                    ул. Придорожная, 36<br>
                    Индекс: 461710
                </div>
                <div style="text-align: right;">
                    Документ сгенерирован автоматически<br>
                    и не требует подписи и печати.<br>
                    ${dateStr}
                </div>
            </div>
        </div>
    </div>`;

    const container = document.createElement('div');
    container.innerHTML = template;
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    document.body.appendChild(container);

    const element = container.querySelector('#cp-pdf-content');

    const opt = {
        margin: 0,
        filename: `${cpNumber}_${product.name.replace(/\s+/g, '_')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save().then(() => {
        container.remove();
        closeCPModal();
    }).catch(err => {
        console.error('PDF generation error:', err);
        container.remove();
        alert('Ошибка генерации PDF. Попробуйте ещё раз.');
    });
}