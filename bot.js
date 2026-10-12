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
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("❌ خطأ أثناء حفظ قاعدة البيانات:", e.message);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ خطأ: لم يتم العثور على BOT_TOKEN في متغيرات البيئة!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// معالج أخطاء لمنع انهيار البوت عند انقطاع الشبكة
bot.catch((err, ctx) => {
  console.error(`❌ خطأ غير متوقع في البوت:`, err.message);
});

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
  console.log("🔄 جاري فحص جميع المنتجات في الخلفية...");
  let products = loadDatabase();
  
  for (let product of products) {
    const { price: currentPrice } = await fetchAmazonData(product.url);
    
    if (currentPrice) {
      console.log(`🔍 فحص [${product.title.substring(0, 15)}...]: السعر الحالي ${currentPrice} | الأدنى ${product.targetPrice} | الأعلى ${product.maxPrice}`);
      
      let dropAlert = false;
      let alertReason = "";

      // شروط التنبيه للمنتج المخصص
      if (currentPrice <= product.targetPrice) {
        dropAlert = true;
        alertReason = `🎯 السعر وصل للحد الأدنى المستهدف أو أقل!`;
      } else if (product.maxPrice > 0 && currentPrice >= product.targetPrice && currentPrice <= product.maxPrice) {
        dropAlert = true;
        alertReason = `📊 السعر دخل جوه المدى المخصص للمنتج (بين ${product.targetPrice} و ${product.maxPrice})`;
      } else if (product.lastPrice && currentPrice <= product.lastPrice * 0.85) {
        dropAlert = true;
        alertReason = `🔥 هبوط مفاجئ وكبير في السعر!`;
      }

      product.lastPrice = currentPrice;
      saveDatabase(products);

      if (dropAlert) {
        const message = `🎉 **تنبيه ذكي للمنتج!**\n\n` +
                        `📢 **السبب:** ${alertReason}\n\n` +
                        `📦 **المنتج:** ${product.title}\n` +
                        `💰 **السعر الحالي:** ${currentPrice} ج.م\n` +
                        `🎯 **الحد الأدنى:** ${product.targetPrice} ج.م | 📈 **الحد الأعلى:** ${product.maxPrice || 'غير محدد'} ج.م\n\n` +
                        `🔗 [اضغط هنا للشراء الآن](${product.url})`;

        try {
          await bot.telegram.sendMessage(product.chatId, message, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error("❌ فشل إرسال الإشعار:", err.message);
        }
      }
    }
    await new Promise(res => setTimeout(res, 2000));
  }
}

// فحص الأسعار كل دقيقة
setInterval(checkAllProducts, 60 * 1000);

bot.start(async (ctx) => {
  try {
    const welcomeMsg = `أهلاً بك في **بوت تتبع أسعار أمازون 🛒**\n\nاستخدم الأزرار أدناه للتحكم الكامل في منتجاتك بكل سهولة:`;
    await ctx.reply(welcomeMsg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة منتج جديد للتتبع', 'start_add')],
        [Markup.button.callback('📋 قائمة منتجاتي المتابعة', 'show_list')]
      ])
    });
  } catch (err) {
    console.error("❌ خطأ في /start:", err.message);
  }
});

bot.action('start_add', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    userState[ctx.from.id] = { step: 'waiting_url' };
    await ctx.editMessageText('🔗 **الخطوة 1/3:** أرسل الآن **رابط منتج أمازون**:', { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("❌ خطأ في start_add:", err.message);
  }
});

bot.on('text', async (ctx) => {
  try {
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
      return ctx.reply('🎯 **الخطوة 2/3:** أرسل الآن **الحد الأدنى (أقل سعر)** لهذا المنتج:', { parse_mode: 'Markdown' });
    }

    if (state.step === 'waiting_target') {
      const targetPrice = parseFloat(text);
      if (isNaN(targetPrice)) {
        return ctx.reply('❌ يرجى إدخال رقم صحيح.');
      }
      state.targetPrice = targetPrice;
      state.step = 'waiting_max';
      return ctx.reply('📈 **الخطوة 3/3:** أرسل الآن **الحد الأعلى** لهذا المنتج (أو اكتب `0` لو مش فارق معاك):', { parse_mode: 'Markdown' });
    }

    if (state.step === 'waiting_max') {
      const maxPrice = parseFloat(text);
      state.maxPrice = isNaN(maxPrice) ? 0 : maxPrice;

      const loadingMsg = await ctx.reply('⏳ جاري جلب بيانات المنتج وحفظه...');
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

      const successText = `✅ **تمت إضافة المنتج بنجاح مع نطاقه المخصص!**\n\n` +
                          `📦 **المنتج:** ${title}\n` +
                          `💰 **السعر الحالي:** ${price || 'غير معروف'} ج.م\n` +
                          `🎯 **الأدنى:** ${state.targetPrice} ج.م | 📈 **الأعلى:** ${state.maxPrice || 'غير محدد'}`;

      await ctx.telegram.editMessageText(userId, loadingMsg.message_id, null, successText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 عرض قائمة منتجاتي', 'show_list')],
          [Markup.button.callback('➕ إضافة منتج آخر', 'start_add')]
        ])
      });
    }
  } catch (err) {
    console.error("❌ خطأ في معالجة النص:", err.message);
  }
});

function sendProductList(ctx) {
  try {
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
                 `💰 الحالي: ${p.lastPrice} | 🎯 الأدنى: ${p.targetPrice} | 📈 الأعلى: ${p.maxPrice || '∞'}\n\n`;

      buttons.push([
        Markup.button.callback(`🔄 تحديث #${index + 1}`, `update_${p.id}`),
        Markup.button.callback(`🗑️ حذف #${index + 1}`, `delete_${p.id}`)
      ]);
    });

    buttons.push([Markup.button.callback('➕ إضافة منتج آخر', 'start_add')]);

    if (ctx.callbackQuery) {
      return ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } else {
      return ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
  } catch (err) {
    console.error("❌ خطأ في sendProductList:", err.message);
  }
}

bot.action('show_list', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    sendProductList(ctx);
  } catch (err) {
    console.error("❌ خطأ في show_list:", err.message);
  }
});

bot.action(/update_(\d+)/, async (ctx) => {
  try {
    const id = parseInt(ctx.match[1]);
    let products = loadDatabase();
    const product = products.find(p => p.id === id);

    if (!product) {
      return ctx.answerCbQuery('❌ المنتج غير موجود!');
    }

    await ctx.answerCbQuery('🔄 جاري تحديث السعر...');
    const { price } = await fetchAmazonData(product.url);

    if (price) {
      product.lastPrice = price;
      saveDatabase(products);
      await ctx.reply(`📊 **السعر المحدث (${product.title.substring(0, 15)}...):** ${price} ج.م`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ تعذر جلب السعر حالياً.');
    }
  } catch (err) {
    console.error("❌ خطأ في تحديث المنتج:", err.message);
  }
});

bot.action(/delete_(\d+)/, async (ctx) => {
  try {
    const id = parseInt(ctx.match[1]);
    let products = loadDatabase();
    const updated = products.filter(p => p.id !== id);
    saveDatabase(updated);

    await ctx.answerCbQuery('🗑️ تم الحذف بنجاح');
    sendProductList(ctx);
  } catch (err) {
    console.error("❌ خطأ في حذف المنتج:", err.message);
  }
});

bot.launch().then(() => {
  console.log('🤖 البوت يعمل الآن بشكل مستقر مع السيرفر السحابي!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
