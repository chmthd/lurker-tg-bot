const KV_NAMESPACE = 'WALLETS';
const SOLSCAN_TOKEN_API_URL = 'https://public-api.solscan.io/token/meta?tokenAddress=';

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
    const messages = await createMessagesFromUpdate(update, env);
    for (const message of messages) {
      if (message) {
        console.log('Sending Telegram message:', message);
        await sendTelegramMessage(message, env);
      } else {
        console.log('No relevant transaction found.');
      }
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
  const name = url.searchParams.get('name');
  if (wallet && name) {
    await env[KV_NAMESPACE].put(wallet, 'tracked', { metadata: { name } });
    console.log(`Wallet ${wallet} with name ${name} added for tracking.`);
    await sendTelegramMessage(`Wallet ${wallet} with name ${name} added for tracking.`, env);
    return new Response('Wallet added', { status: 200 });
  }
  return new Response('Wallet address or name missing', { status: 400 });
}

async function removeWallet(request, env) {
  const url = new URL(request.url);
  const wallet = url.searchParams.get('address');
  if (wallet) {
    await env[KV_NAMESPACE].delete(wallet);
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

async function createMessagesFromUpdate(update, env) {
  if (!update || !Array.isArray(update) || update.length === 0) return [];

  const trackedWallets = await getTrackedWallets(env);
  const messages = [];

  for (const tx of update) {
    const message = await processTransaction(tx, trackedWallets);
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

async function processTransaction(tx, trackedWallets) {
  const { tokenTransfers, nativeTransfers, signature, source, timestamp } = tx;
  let solAmount = 0;
  let tokenTransferAmount = 0;
  let trackingAddress = null;
  let transactionType = null; // BUY or SELL
  let tokenMint = null;

  for (const transfer of tokenTransfers) {
    if (trackedWallets[transfer.fromUserAccount] || trackedWallets[transfer.toUserAccount]) {
      trackingAddress = trackedWallets[transfer.fromUserAccount] ? transfer.fromUserAccount : transfer.toUserAccount;
      transactionType = trackedWallets[transfer.fromUserAccount] ? 'SELL' : 'BUY';
      tokenTransferAmount = parseFloat(transfer.tokenAmount);
      tokenMint = transfer.mint;
      break;
    }
  }

  for (const transfer of nativeTransfers) {
    if (trackedWallets[transfer.fromUserAccount] || trackedWallets[transfer.toUserAccount]) {
      solAmount = parseFloat(transfer.amount) / 1000000000; // Convert lamports to SOL
      break;
    }
  }

  if (transactionType && trackingAddress) {
    const walletName = trackedWallets[trackingAddress];
    const solValue = transactionType === 'SELL' ? `+${solAmount.toFixed(2)}` : `-${solAmount.toFixed(2)}`;
    const tokenValue = transactionType === 'SELL' ? `-${tokenTransferAmount.toFixed(2)}` : `+${tokenTransferAmount.toFixed(2)}`;
    const tokenLink = `https://solscan.io/token/${tokenMint}`;
    const tokenName = await fetchTokenName(tokenMint);

    const message = `
${transactionType === 'SELL' ? `🔴 <a href="https://solscan.io/tx/${signature}">SELL</a>` : `🟢 <a href="https://solscan.io/tx/${signature}">BUY</a>`} on ${source}
<code>${trackingAddress}</code>
(<b>${walletName}</b>)

🔹<b>${walletName}</b>:
<b>SOL_RECEIVED</b>: ${solValue}
<b><a href="${tokenLink}">${tokenName}</a></b>: ${tokenValue}
    `;

    return message;
  }

  return null;
}

async function fetchTokenName(tokenMint) {
  try {
    const response = await fetch(`${SOLSCAN_TOKEN_API_URL}${tokenMint}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch token name: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data.symbol || 'Unknown';
  } catch (error) {
    console.error('Error fetching token name:', error);
    return 'Unknown';
  }
}

async function sendTelegramMessage(message, env) {
  const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: env.CHAT_ID,
    text: message,
    parse_mode: 'HTML'
  };
  const response = await fetchWithRetry(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      console.error(`Rate limited by Telegram. Retry after ${retryAfter} seconds.`);
    } else {
      console.error(`Failed to send message: ${response.statusText}`);
    }
  }

  return response;
}

async function handleTelegramCommand(update, env) {
  const message = update.message;
  const chatId = message.chat.id;
  const text = message.text;
  const [command, ...args] = text.split(' ');

  if (command === '/add') {
    const name = args[0];
    const wallet = args[1];
    if (name && wallet) {
      await addWalletToKV(wallet, name, env);
      console.log(`Wallet ${wallet} with name ${name} added for tracking.`);
      await sendTelegramMessageTo(chatId, `Wallet ${wallet} with name ${name} added for tracking.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Please provide both a name and a wallet address.', env);
    }
  } else if (command === '/remove') {
    const wallet = args[0];
    if (wallet) {
      await removeWalletFromKV(wallet, env);
      console.log(`Wallet ${wallet} removed from tracking.`);
      await sendTelegramMessageTo(chatId, `Wallet ${wallet} removed from tracking.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Wallet address missing or not found.', env);
    }
  } else if (command === '/removeall') {
    const confirmation = args[0];
    if (confirmation === 'confirm') {
      const keys = await env[KV_NAMESPACE].list();
      for (const key of keys.keys) {
        await env[KV_NAMESPACE].delete(key.name);
      }
      console.log(`All wallets have been removed from tracking.`);
      await sendTelegramMessageTo(chatId, `All wallets have been removed from tracking.`, env);
    } else {
      await sendTelegramMessageTo(chatId, 'Please type "confirm" after the /removeall command to confirm.', env);
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
    const walletsList = await getTrackedWalletsList(env);
    const totalWallets = (await env[KV_NAMESPACE].list()).keys.length;
    const responseMessage = walletsList ? `<b>Tracked wallets (${totalWallets}):</b>\n${walletsList}` : 'No wallets are being tracked.';
    await sendTelegramMessageTo(chatId, responseMessage, env);
  } else {
    await sendTelegramMessageTo(chatId, 'Unknown command. Use /add <name> <wallet_address> to add, /remove <wallet_address> to remove, /winrate <wallet_address> to get win rate, and /wallets to view tracked wallets.', env);
  }
}

async function sendTelegramMessageTo(chatId, message, env) {
  const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML'
  };
  const response = await fetchWithRetry(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      console.error(`Rate limited by Telegram. Retry after ${retryAfter} seconds.`);
    } else {
      console.error(`Failed to send message: ${response.statusText}`);
    }
  }

  return response;
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

async function getTrackedWallets(env) {
  const keys = await env[KV_NAMESPACE].list();
  const wallets = {};
  keys.keys.forEach(key => {
    const metadata = key.metadata ? key.metadata : {};
    wallets[key.name] = metadata.name || 'No name';
  });
  return wallets;
}

async function getTrackedWalletsList(env) {
  const keys = await env[KV_NAMESPACE].list();
  return keys.keys.map(key => {
    const metadata = key.metadata ? key.metadata : {};
    return `<code>${key.name}</code> (${metadata.name || 'No name'})`;
  }).join('\n');
}

async function addWalletToKV(wallet, name, env) {
  await env[KV_NAMESPACE].put(wallet, 'tracked', { metadata: { name } });
}

async function removeWalletFromKV(wallet, env) {
  await env[KV_NAMESPACE].delete(wallet);
}
