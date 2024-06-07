const KV_NAMESPACE = 'WALLETS';
const IGNORED_ADDRESS = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe';
const SOL_DECIMALS = 9;

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
    console.log('Webhook update received:', JSON.stringify(update));
    const message = await createMessageFromUpdate(update, env);
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
  const name = url.searchParams.get('name');
  if (wallet && name) {
    await env[KV_NAMESPACE].put(wallet, JSON.stringify({ name }));
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

async function createMessageFromUpdate(update, env) {
  if (!update || !Array.isArray(update) || update.length === 0) return null;

  const trackedWallets = await getTrackedWallets(env);

  for (const tx of update) {
    const involvedAddresses = new Set();

    if (tx.nativeTransfers) {
      for (const transfer of tx.nativeTransfers) {
        involvedAddresses.add(transfer.fromUserAccount);
        involvedAddresses.add(transfer.toUserAccount);
        if (transfer.toUserAccount === IGNORED_ADDRESS) continue;
        if (trackedWallets.has(transfer.fromUserAccount) || trackedWallets.has(transfer.toUserAccount)) {
          const amountSOL = (transfer.amount / Math.pow(10, SOL_DECIMALS)).toFixed(9);
          tx.nativeTransfers = tx.nativeTransfers.map(t => ({
            ...t,
            amount: t.amount / Math.pow(10, SOL_DECIMALS)
          }));
        }
      }
    }

    if (tx.accountData) {
      for (const account of tx.accountData) {
        involvedAddresses.add(account.account);
        if (trackedWallets.has(account.account)) {
          return `New transaction detected involving wallet:\n\n${JSON.stringify(tx)}`;
        }
      }
    }

    if (tx.tokenTransfers) {
      for (const transfer of tx.tokenTransfers) {
        involvedAddresses.add(transfer.fromUserAccount);
        involvedAddresses.add(transfer.toUserAccount);
        if (trackedWallets.has(transfer.fromUserAccount) || trackedWallets.has(transfer.toUserAccount)) {
          return `New token transfer detected involving wallet:\n\n${JSON.stringify(tx)}`;
        }
      }
    }

    for (const address of involvedAddresses) {
      if (trackedWallets.has(address) && !involvedAddresses.has(IGNORED_ADDRESS)) {
        return `New transaction detected involving wallet:\n\n${JSON.stringify(tx)}`;
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
    const responseMessage = walletsList ? `Tracked wallets: ${totalWallets}\n${walletsList}` : 'No wallets are being tracked.';
    await sendTelegramMessageTo(chatId, responseMessage, env);
  } else {
    await sendTelegramMessageTo(chatId, 'Unknown command. Use /add <name> <wallet_address> to add, /remove <wallet_address> to remove, /winrate <wallet_address> to get win rate, and /wallets to view tracked wallets.', env);
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

async function getTrackedWallets(env) {
  const keys = await env[KV_NAMESPACE].list();
  const wallets = new Map();
  for (const key of keys.keys) {
    const metadata = JSON.parse(key.metadata || '{}');
    wallets.set(key.name, metadata.name);
  }
  return wallets;
}

async function getTrackedWalletsList(env) {
  const keys = await env[KV_NAMESPACE].list();
  return keys.keys.map(key => {
    const metadata = JSON.parse(key.metadata || '{}');
    return `${key.name} (${metadata.name || 'No Name'})`;
  }).join('\n');
}

async function addWalletToKV(wallet, name, env) {
  await env[KV_NAMESPACE].put(wallet, '', { metadata: JSON.stringify({ name }) });
}

async function removeWalletFromKV(wallet, env) {
  await env[KV_NAMESPACE].delete(wallet);
}
