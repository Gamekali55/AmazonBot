const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const DB_FILE = 'products.json';
const userState = {};

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ خطأ: لم يتم العثور على BOT_TOKEN في متغيرات البيئة!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

async function fetchAmazonData(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    const title = $('#productTitle').text().trim() || 'منتج أمازون';
    
    let priceText = $('.a-price .a-offscreen').first().text().trim();
    if (!priceText) {
      priceText = $('#priceblock_ourprice').text().trim() || $('#priceblock_dealprice').text().trim();
    }
    
    const priceMatch = priceText.replace(/,/g, '').match(/[\d.]+/);
    const price = priceMatch ? parseFloat(priceMatch[0]) : null;

    return { title, price };
  } catch (error) {
    console.error(`❌ خطأ أثناء جلب الرابط ${url}:`, error.message);
    return { title: 'منتج أمازون', price: null };
  }
}

async function checkAllProducts() {
  console.log("🔄 جاري بدء الفحص التلقائي لجميع المنتجات في الخلفية كل دقيقة...");
  let products = loadDatabase();
  
  for (let product of products) {
    const { price: currentPrice } = await fetchAmazonData(product.url);
    
    if (currentPrice) {
      console.log(`🔍 تم فحص [${product.title.substring(0, 20)}...]: السعر الحالي ${currentPrice} ج.م | المستهدف ${product.targetPrice} ج.م`);
      
      let dropAlert = false;
      if (currentPrice <= product.targetPrice) {
        dropAlert = true;
      } else if (product.lastPrice && currentPrice <= product.lastPrice * 0.85) {
        dropAlert = true;
      }

      product.lastPrice = currentPrice;
      saveDatabase(products);

      if (dropAlert) {
        const message = `🎉 **تنبيه انخفاض سعر مفاجئ!**\n\n` +
                        `📦 **المنتج:** ${product.title}\n` +
                        `💰 **السعر الحالي:** ${currentPrice} ج.م\n` +
                        `🎯 **السعر المستهدف:** ${product.targetPrice} ج.م\n\n` +
                        `🔗 [اضغط هنا للشراء الآن قبل فوات الأوان](${product.url})`;

        bot.telegram.sendMessage(product.chatId, message, { parse_mode: 'Markdown' })
          .catch(err => console.error("❌ فشل إرسال الإشعار:", err.message));
      }
    }
    await new Promise(res => setTimeout(res, 2000));
  }
}

setInterval(checkAllProducts, 60 * 1000);

bot.start((ctx) => {
  const welcomeMsg = `أهلاً بك في **بوت تتبع أسعار أمازون 🛒**\n\nاستخدم الأزرار أدناه للتحكم الكامل في منتجاتك بكل سهولة:`;
  ctx.reply(welcomeMsg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ إضافة منتج جديد للتتبع', 'start_add')],
      [Markup.button.callback('📋 قائمة منتجاتي المتابعة', 'show_list')]
    ])
  });
});

bot.action('start_add', (ctx) => {
  ctx.answerCbQuery();
  userState[ctx.from.id] = { step: 'waiting_url' };
  ctx.editMessageText('🔗 **الخطوة 1/3:** أرسل الآن **رابط منتج أمازون** الذي تريد تتبعه:', { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (!userState[userId]) return;

  const state = userState[userId];

  if (state.step === 'waiting_url') {
    if (!text.includes('http')) {
      return ctx.reply('❌ يرجى إرسال رابط صحيح يبدأ بـ http أو https');
    }
    state.url = text;
    state.step = 'waiting_target';
    return ctx.reply('🎯 **الخطوة 2/3:** أرسل الآن **أقل سعر أو السعر المستهدف** (بالأرقام فقط، مثلاً: 150):', { parse_mode: 'Markdown' });
  }

  if (state.step === 'waiting_target') {
    const targetPrice = parseFloat(text);
    if (isNaN(targetPrice)) {
      return ctx.reply('❌ يرجى إدخال رقم صحيح للسعر المستهدف.');
    }
    state.targetPrice = targetPrice;
    state.step = 'waiting_max';
    return ctx.reply('📈 **الخطوة 3/3:** أرسل الآن **أعلى سعر** (أو اكتب `0` لو مش فارق معاك أعلى سعر):', { parse_mode: 'Markdown' });
  }

  if (state.step === 'waiting_max') {
    const maxPrice = parseFloat(text);
    state.maxPrice = isNaN(maxPrice) ? 0 : maxPrice;

    const loadingMsg = await ctx.reply('⏳ جاري جلب بيانات المنتج من أمازون وحفظه...');
    const { title, price } = await fetchAmazonData(state.url);

    let products = loadDatabase();
    const newProduct = {
      id: Date.now(),
      chatId: userId,
      url: state.url,
      title: title,
      targetPrice: state.targetPrice,
      maxPrice: state.maxPrice,
      lastPrice: price || 0
    };

    products.push(newProduct);
    saveDatabase(products);
    delete userState[userId];

    const successText = `✅ **تمت إضافة المنتج بنجاح للقوائم!**\n\n` +
                        `📦 **المنتج:** ${title}\n` +
                        `💰 **السعر الحالي:** ${price || 'غير معروف'} ج.م\n` +
                        `🎯 **السعر المستهدف:** ${state.targetPrice} ج.م\n` +
                        `📈 **أعلى سعر:** ${state.maxPrice || 'غير محدد'}`;

    await ctx.telegram.editMessageText(userId, loadingMsg.message_id, null, successText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 عرض قائمة منتجاتي', 'show_list')],
        [Markup.button.callback('➕ إضافة منتج آخر', 'start_add')]
      ])
    });
  }
});

function sendProductList(ctx) {
  let products = loadDatabase();
  const chatId = ctx.chat ? ctx.chat.id : ctx.from.id;
  let userProducts = products.filter(p => p.chatId === chatId);

  if (userProducts.length === 0) {
    const emptyMsg = '📭 **قائمة منتجاتك فارغة حالياً!**';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ إضافة منتج جديد', 'start_add')]
    ]);
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyMsg, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.reply(emptyMsg, { parse_mode: 'Markdown', ...keyboard });
  }

  let message = `📋 **قائمة منتجاتك المتابعة (${userProducts.length}):**\n\n`;
  const buttons = [];

  userProducts.forEach((p, index) => {
    message += `${index + 1}. **${p.title.substring(0, 25)}...**\n` +
               `💰 السعر الحالي: ${p.lastPrice} ج.م | 🎯 المستهدف: ${p.targetPrice} ج.م\n\n`;

    buttons.push([
      Markup.button.callback(`🔄 تحديث #${index + 1}`, `update_${p.id}`),
      Markup.button.callback(`🗑️ حذف #${index + 1}`, `delete_${p.id}`)
    ]);
  });

  buttons.push([Markup.button.callback('➕ إضافة منتج آخر', 'start_add')]);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  } else {
    return ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

bot.action('show_list', (ctx) => {
  ctx.answerCbQuery();
  sendProductList(ctx);
});

bot.action(/update_(\d+)/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  let products = loadDatabase();
  const product = products.find(p => p.id === id);

  if (!product) {
    return ctx.answerCbQuery('❌ المنتج غير موجود!');
  }

  ctx.answerCbQuery('🔄 جاري تحديث السعر...');
  const { price } = await fetchAmazonData(product.url);

  if (price) {
    product.lastPrice = price;
    saveDatabase(products);
    ctx.reply(`📊 **السعر المحدث (${product.title.substring(0, 15)}...):** ${price} ج.م`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('❌ تعذر جلب السعر حالياً.');
  }
});

bot.action(/delete_(\d+)/, (ctx) => {
  const id = parseInt(ctx.match[1]);
  let products = loadDatabase();
  const updated = products.filter(p => p.id !== id);
  saveDatabase(updated);

  ctx.answerCbQuery('🗑️ تم الحذف بنجاح');
  sendProductList(ctx);
});

bot.launch().then(() => {
  console.log('🤖 البوت يعمل بكامل القوائم التفاعلية وتنبيهات الأسعار!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
