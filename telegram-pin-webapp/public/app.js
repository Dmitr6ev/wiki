(function(){
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.expand(); }

  const titleInput = document.getElementById('title-input');
  const createBtn = document.getElementById('create-btn');
  const listEl = document.getElementById('messages-list');

  const initDataUnsafe = tg?.initDataUnsafe || {};
  const chatId = initDataUnsafe?.chat?.id || null;

  async function fetchMessages(){
    if (!chatId) { renderList([]); return; }
    const r = await fetch(`/api/messages?chat_id=${encodeURIComponent(chatId)}`);
    const data = await r.json();
    renderList(data.items || []);
  }

  function renderList(items){
    listEl.innerHTML = '';
    items.forEach((m)=>{
      const div = document.createElement('div');
      div.className = 'card';
      div.textContent = `${m.title} (#${m.messageId})`;
      listEl.appendChild(div);
    });
  }

  createBtn.addEventListener('click', async ()=>{
    const title = titleInput.value.trim();
    if (!title) return alert('Введите заголовок');
    if (!chatId) return alert('Откройте WebApp из чата, чтобы получить chat_id');
    try {
      const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, title }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      titleInput.value = '';
      await fetchMessages();
    } catch (e){
      alert(String(e));
    }
  });

  fetchMessages();
})();

