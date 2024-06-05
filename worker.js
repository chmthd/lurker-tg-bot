const walletAddresses = new Set();

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  console.log(`Received request with pathname: ${pathname}`);

  if (pathname === '/webhook') {
    return handleWebhook(request, env);
  } else if (pathname.startsWith('/addwallet')) {
    return addWallet(request, env);
  } else if (pathname.startsWith('/removewallet')) {
    return removeWallet(request, env);
  } else if (pathname.startsWith('/bot')) {
    return handleBot(request, env);
  }
  return new Response('Not Found', { status: 404 });
}

async function handleWebhook(request, env) {
  try {
    const update = await request.json();
    console.log('Webhook update received:', JSON.stringify(update, null, 2));
    const message = createMessageFromUpdate(update);
    if (message) {
      console.log('Sending Telegram message:', message);
      await sendTelegramMessage(message, env);
    } else {
      console.log('No relevant transaction found.');
    }
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error handling webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function addWallet(request, env) {
  const url = new URL(request.url);
  const wallet = url.searchParams.get('address');
  if (wallet) {
    walletAddresses.add(wallet);
    console.log(`Wallet ${wallet} added for tracking.`);
    await sendTelegramMessage(`Wallet ${wallet} added for tracking.`, env);
    return new Response('Wallet added', { status: 200 });
  }
  return new Response('Wallet address missing', { status: 400 });
}

async function removeWallet(request, env) {
  const url = new URL(request.url);
  const wallet = url.searchParams.get('address');
  if (wallet && walletAddresses.has(wallet)) {
    walletAddresses.delete(wallet);
    console.log(`Wallet ${wallet} removed from tracking.`);
    await sendTelegramMessage(`Wallet ${wallet} removed from tracking.`, env);
    return new Response('Wallet removed', { status: 200 });
  }
  return new Response('Wallet address missing or not found', { status: 400 });
}

async function handleBot(request, env) {
  const update = await request.json();
  await handleTelegramCommand(update, env);
  return new Response('OK', { status: 200 });
}

function createMessageFromUpdate(update) {
  if (!update || !Array.isArray(update) || update.length === 0) return null;

  for (const tx of update) {
    if (tx.nativeTransfers) {
      for (const transfer of tx.nativeTransfers) {
        if (walletAddresses.has(transfer.fromUserAccount) || walletAddresses.has(transfer.toUserAccount)) {
          return `New transaction detected involving wallet:\n\n${JSON.stringify(transfer, null, 2)}`;
        }
      }
    }
    
    if (tx.accountData) {
      for (const account of tx.accountData) {
        if (walletAddresses.has(account.account)) {
          return `New transaction detected involving wallet:\n\n${JSON.stringify(account, null, 2)}`;
        }
      }
    }

    if (tx.tokenTransfers) {
      for (const transfer of tx.tokenTransfers) {
        if (walletAddresses.has(transfer.fromUserAccount) || walletAddresses.has(transfer.toUserAccount)) {
          return `New token transfer detected involving wallet:\n\n${JSON.stringify(transfer, null, 2)}`;
        }
      }
    }
  }
  
  return null;
}

async function sendTelegramMessage(message, env) {
  const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: env.CHAT_ID,
    text: message
  };
  await fetchWithRetry(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function handleTelegramCommand(update, env) {
  const message = update.message;
  const chatId = message.chat.id;
  const text = message.text;
  const [command, ...args] = text.split(' ');

  if (command === '/add') {
    const wallet = args[0];
    if (wallet) {
      walletAddresses.add(wallet);
      console.log(`Wallet ${wallet} added for tracking.`);
      await sendTelegramMessageTo(chatId, `Wallet ${wallet} added for tracking.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Please provide a wallet address.', env);
    }
  } else if (command === '/remove') {
    const wallet = args[0];
    if (wallet && walletAddresses.has(wallet)) {
      walletAddresses.delete(wallet);
      console.log(`Wallet ${wallet} removed from tracking.`);
      await sendTelegramMessageTo(chatId, `Wallet ${wallet} removed from tracking.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Wallet address missing or not found.', env);
    }
  } else if (command === '/winrate') {
    const wallet = args[0];
    if (wallet) {
      const winRate = await calculateWinRate(wallet, env);
      await sendTelegramMessageTo(chatId, `Wallet ${wallet} has a win rate of ${winRate}%.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Please provide a wallet address.', env);
    }
  } else if (command === '/wallets') {
    const walletsList = Array.from(walletAddresses).join('\n');
    const responseMessage = walletsList ? `Tracked wallets:\n${walletsList}` : 'No wallets are being tracked.';
    await sendTelegramMessageTo(chatId, responseMessage, env);
  } else {
    await sendTelegramMessageTo(chatId, 'Unknown command. Use /add <wallet_address> to add, /remove <wallet_address> to remove, and /winrate <wallet_address> to get win rate.', env);
  }
}

async function sendTelegramMessageTo(chatId, message, env) {
  const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message
  };
  await fetchWithRetry(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`Fetch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) {
        throw error;
      }
    }
  }
}

async function calculateWinRate(wallet, env) {
  const heliusApiUrl = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${env.HELIUS_API_KEY}`;
  
  try {
    const response = await fetchWithRetry(heliusApiUrl, { method: 'GET' });
    const transactions = await response.json();
    
    let wins = 0;
    let totalTrades = transactions.length;

    for (const tx of transactions) {
      if (/* your condition for a win */ false) {
        wins++;
      }
    }

    return (wins / totalTrades) * 100;
  } catch (error) {
    console.error('Error calculating win rate:', error);
    return 0;
  }
}
