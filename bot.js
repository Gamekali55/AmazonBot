const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const DB_FILE = 'products.json';

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
      priceText = $('#priceblock_ourprice').text().trim() \vert{}\vert{} $('#priceblock_dealprice').text().trim();
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
      console.log(`🔍 تم فحص [${product.title.substring(0, 20)}...]: السعر الحالي ${currentPrice} ج.م | السعر المستهدف ${product.targetPrice} ج.م`);
      
      product.lastPrice = currentPrice;
      saveDatabase(products);

      if (currentPrice <= product.targetPrice) {
        const message = `🎉 **تنبيه انخفاض السعر!**\n\n` +
                        `📦 **المنتج:** ${product.title}\n` +
                        `💰 **السعر الحالي:** ${currentPrice} ج.م\n` +
                        `🎯 **السعر المطلوب:** ${product.targetPrice} ج.م\n\n` +
                        `🔗 [اضغط هنا للشراء الآن](${product.url})`;

        bot.telegram.sendMessage(product.chatId, message, { parse_mode: 'Markdown' })
          .catch(err => console.error("❌ فشل إرسال الإشعار:", err.message));
      }
    }
    await new Promise(res => setTimeout(res, 2000));
  }
}

setInterval(checkAllProducts, 60 * 1000);

bot.start((ctx) => {
  ctx.reply('أهلاً بك! أرسل لي أمر التتبع بهذا الشكل:\n\n`/track <الرابط> <السعر_المستهدف>`\n\nمثال:\n`/track https://amzn.eu/d/xyz 150`', { parse_mode: 'Markdown' });
});

bot.command('track', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const url = args[1];
  const targetPrice = parseFloat(args[2]);

  if (!url || isNaN(targetPrice)) {
    return ctx.reply('❌ يرجى إدخال الأمر بشكل صحيح:\n`/track <الرابط> <السعر_المستهدف>`', { parse_mode: 'Markdown' });
  }

  const loadingMsg = await ctx.reply('⏳ جاري إحضار بيانات المنتج من أمازون...');
  const { title, price } = await fetchAmazonData(url);

  if (!price) {
    return ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, '❌ متعذر جلب سعر المنتج، تأكد من صحة الرابط.');
  }

  let products = loadDatabase();
  const newProduct = {
    id: Date.now(),
    chatId: ctx.chat.id,
    url,
    title,
    targetPrice,
    lastPrice: price
  };

  products.push(newProduct);
  saveDatabase(products);

  const replyText = `✅ **تمت الإضافة بنجاح!**\n\n` +
                    `📦 **المنتج:** ${title}\n` +
                    `💰 **السعر الحالي:** ${price} ج.م\n` +
                    `🎯 **السعر المستهدف:** ${targetPrice} ج.م`;

  ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, replyText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 تحديث السعر الآن', `update_${newProduct.id}`)]
    ])
  });
});

bot.action(/update_(\d+)/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  let products = loadDatabase();
  const product = products.find(p => p.id === id);

  if (!product) {
    return ctx.answerCbQuery('❌ لم يتم العثور على المنتج!');
  }

  ctx.answerCbQuery('🔄 جاري تحديث السعر...');
  const { price } = await fetchAmazonData(product.url);

  if (price) {
    product.lastPrice = price;
    saveDatabase(products);
    ctx.reply(`📊 **السعر الحالي للمنتج (${product.title.substring(0, 15)}...):** ${price} ج.م`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('❌ تعذر تحديث السعر حالياً، حاول لاحقاً.');
  }
});

bot.launch().then(() => {
  console.log('🤖 البوت يعمل بنجاح ومستعد لفحص الأسعار تلقائياً كل دقيقة!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
