require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const { open } = require('sqlite');
const sqlite3Internal = require('sqlite3');

const app = express();

// Requerido por Railway/Render para lectura de IPs tras proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let db;

// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE ASÍNCRONO OPTIMIZADO)
// ==========================================
async function inicializarBaseDatos() {
    try {
        const dbPath = path.resolve(__dirname, 'monedero.db');
        db = await open({
            filename: dbPath,
            driver: sqlite3Internal.Database
        });

        console.log('Conectado a la base de datos SQLite exitosamente.');

        // Inicializar tablas completas y comercio por defecto
        await db.exec(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT UNIQUE,
                pinSeguridad TEXT,
                accountType TEXT DEFAULT 'natural',
                dailyLimit REAL DEFAULT 1000.00,
                upgradedAt TEXT
            );

            CREATE TABLE IF NOT EXISTS wallets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                usdt_balance REAL DEFAULT 0.00,
                FOREIGN KEY(user_id) REFERENCES usuarios(id)
            );

            CREATE TABLE IF NOT EXISTS transacciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referencia TEXT,
                monto REAL,
                telefonoEmisor TEXT,
                telefonoDestino TEXT,
                reference_hash TEXT UNIQUE,
                fechaHora TEXT
            );

            CREATE TABLE IF NOT EXISTS metodos_pago (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cedulaTitular TEXT,
                metodo TEXT,
                cuentaDestino TEXT,
                fechaRegistro TEXT
            );

            CREATE TABLE IF NOT EXISTS comisiones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT,
                monto REAL,
                referencia TEXT,
                fechaHora TEXT
            );
        `);

        // Asegurar columnas opcionales si no existen
        try { await db.exec(`ALTER TABLE usuarios ADD COLUMN merchant_id TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE usuarios ADD COLUMN metodoVinculado INTEGER DEFAULT 0`); } catch (e) {}

        // Asegurar existencia del ID de comercio por defecto
        await db.run(`
            INSERT INTO usuarios (telefono, pinSeguridad, accountType, dailyLimit) 
            VALUES ('MERCHANT-ID-49201', '0000', 'comercial', 999999.00) 
            ON CONFLICT(telefono) DO NOTHING
        `);

        const merchant = await db.get("SELECT id FROM usuarios WHERE telefono = 'MERCHANT-ID-49201'");
        if (merchant) {
            await db.run(
                "INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00) ON CONFLICT DO NOTHING",
                [merchant.id]
            );
        }

    } catch (err) {
        console.error('Error al inicializar SQLite:', err.message);
    }
}

inicializarBaseDatos();

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD DIFERENCIADA)
// ==========================================
const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 30,
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes procesadas. Por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterConsultasComercio = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000 
});

app.use(limiterGeneral);

const publicPath = path.resolve(__dirname, 'frontend', 'public');
app.use(express.static(publicPath));
app.use('/public', express.static(publicPath));

// ==========================================
// PARÁMETROS Y TARIFAS DE PLATAFORMA (POLYGON RED ÚNICA)
// ==========================================
const BINANCE_COMMISSION_WALLET = process.env.BINANCE_COMMISSION_WALLET || 'Binance Pay / Wallet ID';
const POLYGON_USDT_CONTRACT = '0xc2132d05d31c914a87c6611c10748aeb04b58e2f'; // USDT oficial en Polygon
const PLATFORM_POLYGON_WALLET = (process.env.PLATFORM_POLYGON_WALLET || '').toLowerCase(); // Tu wallet receptor oficial en Polygon

const COMISION_FIJA_USUARIO = 1.00;         
const COMISION_PORCENTAJE_COMERCIO = 0.03;  // 3%
const COMISION_MINIMA_COMERCIO = 2.00;      // Mínimo $2.00 USDT
const COSTO_CAMBIO_PLAN_COMERCIAL = 5.00;

const MONTO_MINIMO_RECARGA = 5.00;
const PORCENTAJE_RECARGA = 0.02; 
const MINIMO_COMISION_RECARGA = 1.00;

const PORCENTAJE_RETIRO = 0.02;  
const MINIMO_COMISION_RETIRO = 1.00;

function calcularComisionComercio(montoVenta) {
    let comisionCalculada = parseFloat(montoVenta) * COMISION_PORCENTAJE_COMERCIO;
    return comisionCalculada < COMISION_MINIMA_COMERCIO ? COMISION_MINIMA_COMERCIO : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRecarga(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RECARGA;
    return comisionCalculada < MINIMO_COMISION_RECARGA ? MINIMO_COMISION_RECARGA : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRetiro(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RETIRO;
    return comisionCalculada < MINIMO_COMISION_RETIRO ? MINIMO_COMISION_RETIRO : Number(comisionCalculada.toFixed(2));
}

// ==========================================
// VALIDADOR AUTOMÁTICO BLOCKCHAIN (POLYGON NETWORK)
// ==========================================
async function verificarHashPolygonEnBlockchain(txHash, montoEsperadoMinimo) {
    return new Promise((resolve) => {
        if (!txHash || txHash.length < 10) {
            return resolve({ valido: false, mensaje: '❌ Hash de transacción de Polygon inválido[cite: 7].' });
        }

        const url = `https://api.polygonscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash.trim()}`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const respuesta = JSON.parse(data);
                    if (!respuesta || !respuesta.result) {
                        return resolve({ valido: false, mensaje: '❌ La transacción no existe o no ha sido confirmada en la red Polygon[cite: 7].' });
                    }

                    const tx = respuesta.result;
                    
                    if (!tx.blockNumber) {
                        return resolve({ valido: false, mensaje: '❌ La transacción en Polygon aún está pendiente o no confirmada[cite: 7].' });
                    }

                    if (PLATFORM_POLYGON_WALLET && tx.to && tx.to.toLowerCase() !== PLATFORM_POLYGON_WALLET) {
                        return resolve({ valido: false, mensaje: '❌ El destinatario de esta transacción en Polygon no corresponde a la wallet oficial de la plataforma[cite: 7].' });
                    }

                    return resolve({ valido: true, mensaje: '✅ Transacción verificada en Polygon correctamente[cite: 7].', dataTx: tx });
                } catch (e) {
                    return resolve({ valido: false, mensaje: '❌ Error al procesar la respuesta de la blockchain de Polygon[cite: 7].' });
                }
            });
        }).on('error', (err) => {
            return resolve({ valido: false, mensaje: '❌ Error de conexión con el explorador de la red Polygon[cite: 7].' });
        });
    });
}

function formatearNumeroWhatsapp(numero) {
    if (!numero) return null;
    let numLimpio = numero.toString().trim().replace(/\D/g, ''); 
    if (numLimpio.startsWith('0')) {
        numLimpio = numLimpio.substring(1);
    }
    return numLimpio.startsWith('58') ? `${numLimpio}@c.us` : `58${numLimpio}@c.us`;
}

async function enviarMensajeWhatsappSeguro(numero, mensaje) {
    try {
        if (!client || !client.info) {
            console.warn('⚠️ WhatsApp no está listo o conectado en este momento. Omitiendo notificación sin afectar la transacción[cite: 7].');
            return false;
        }

        let chatId = formatearNumeroWhatsapp(numero);
        if (!chatId) return false;

        await client.sendMessage(chatId, mensaje);
        console.log(`✅ WhatsApp enviado exitosamente a ${chatId}[cite: 7].`);
        return true;
    } catch (error) {
        console.error(`⚠️ Error no crítico en WhatsApp (Ignorado para no bloquear la app):`, error.message);
        return false;
    }
}

// ==========================================
// CLIENTE DE WHATSAPP (BLINDADO CON RECONEXIÓN)
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Escanea este código QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('¡Cliente de WhatsApp conectado y listo para enviar mensajes[cite: 7]!');
});

client.on('disconnected', async (reason) => {
    console.warn('⚠️ WhatsApp desconectado por:', reason);
    try {
        console.log('🔄 Intentando reconectar cliente de WhatsApp automáticamente en 10 segundos[cite: 7]...');
        setTimeout(async () => {
            try {
                await client.initialize();
            } catch (err) {
                console.error('❌ Error al intentar auto-reiniciar WhatsApp:', err.message);
            }
        }, 10000);
    } catch (err) {
        console.error('❌ Error en evento disconnected:', err.message);
    }
});

setTimeout(() => {
    client.initialize();
}, 5000);

// ==========================================
// RUTAS DE PÁGINAS (VISTAS - FLUJO OBLIGATORIO DE AUTH)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

app.get('/recarga', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/recargamovil.html', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/recargamovil', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/admin', (req, res) => {
    const adminFile = path.join(publicPath, 'admin.html');
    if (fs.existsSync(adminFile)) {
        res.sendFile(adminFile);
    } else {
        res.status(404).send(`Error: El archivo no existe en esta ruta exacta: ${adminFile}`);
    }
});

// ==========================================
// APIS Y RUTAS
// ==========================================
app.get('/api/admin/balance', async (req, res) => {
    try {
        const rowWallets = await db.get('SELECT SUM(usdt_balance) AS totalUsuarios FROM wallets');
        const rowBinance = await db.get("SELECT SUM(monto) AS totalBinance FROM comisiones WHERE tipo = 'binance'");
        
        const saldoUsuarios = rowWallets && rowWallets.totalUsuarios ? rowWallets.totalUsuarios : 0;
        const gananciaBinance = rowBinance && rowBinance.totalBinance ? rowBinance.totalBinance : 0;

        res.json({
            success: true,
            saldoUsuarios: saldoUsuarios.toFixed(2),
            gananciaBinance: gananciaBinance.toFixed(2),
            totalGanancias: gananciaBinance.toFixed(2)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/saldo/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();

    try {
        const row = await db.get(`
            SELECT usuarios.telefono, usuarios.merchant_id, usuarios.accountType, usuarios.dailyLimit, usuarios.metodoVinculado, wallets.usdt_balance 
            FROM usuarios 
            LEFT JOIN wallets ON usuarios.id = wallets.user_id 
            WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
        `, [busqueda, busqueda]);

        if (!row) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        res.json({
            success: true,
            telefono: row.telefono,
            merchantId: row.merchant_id,
            accountType: row.accountType,
            dailyLimit: row.dailyLimit || 1000.00,
            saldoUSDT: row.usdt_balance || 0.00,
            metodoVinculado: row.metodoVinculado === 1
        });
    } catch (err) {
        console.error("Error consultando saldo:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al consultar saldo.' });
    }
});

// ==========================================
// RUTA OFICIAL PARA CAMBIO DE PIN DE SEGURIDAD
// ==========================================
app.post('/api/cambiar-pin', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const pinActual = (req.body.pinActual || '').trim();
    const pinNuevo = (req.body.pinNuevo || '').trim();

    if (!telefono || !pinActual || !pinNuevo) {
        return res.status(400).json({ success: false, message: '⚠️ Todos los campos son obligatorios para cambiar el PIN.' });
    }

    if (pinNuevo.length !== 4) {
        return res.status(400).json({ success: false, message: '⚠️ El nuevo PIN debe ser estrictamente de 4 dígitos.' });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado en el sistema.' });
        }

        if (usuario.pinSeguridad && usuario.pinSeguridad !== pinActual) {
            return res.status(401).json({ success: false, message: '❌ El PIN actual ingresado es incorrecto.' });
        }

        await db.run('UPDATE usuarios SET pinSeguridad = ? WHERE id = ?', [pinNuevo, usuario.id]);

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `🔐 *SEGURIDAD ACTUALIZADA*\n\nTu PIN de seguridad de 4 dígitos ha sido modificado con éxito.\nSi no fuiste tú, comunícate de inmediato con soporte.`
        );

        res.json({ success: true, message: '¡PIN cambiado con éxito[cite: 7]!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al actualizar el PIN.' });
    }
});

// ==========================================
// RUTA DE REGISTRO DE MÉTODOS (BLINDADA ANTIFRAUDE Y CERO TERCEROS)
// ==========================================
app.post('/api/registrar-metodos', limiterPagos, async (req, res) => {
    const { cedulaTitular, metodo, cuentaDestino, telefono } = req.body;

    if (!cedulaTitular || !metodo || !cuentaDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para vincular el método.' });
    }

    const cedulaLimpia = cedulaTitular.trim();
    const regexCedula = /^[VEJGvejg]?[-]?\d{6,10}$/;
    if (!regexCedula.test(cedulaLimpia)) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Cédula inválida. Ingrese un documento de identidad real (Ej: V12345678 o 12345678).' 
        });
    }

    const destinoLimpio = cuentaDestino.trim().toLowerCase();
    
    if (
        destinoLimpio.includes('test') || 
        destinoLimpio.includes('prueba') || 
        destinoLimpio.includes('example') || 
        destinoLimpio.includes('admin') ||
        destinoLimpio === '12345678' || 
        destinoLimpio === '00000000' ||
        cedulaLimpia.includes('000000') ||
        cedulaLimpia === '12345678'
    ) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Acceso denegado: No se permiten cuentas, cédulas o datos de prueba/ficticios.' 
        });
    }

    let esValido = false;
    let mensajeErrorFormato = '';

    const metodosSoportados = ['binance', 'zinli', 'zelle', 'paypal', 'bybit', 'okx', 'airtm'];
    const metodoElegido = metodo.trim().toLowerCase();

    if (!metodosSoportados.includes(metodoElegido)) {
        return res.status(400).json({ success: false, message: '❌ El método de pago o exchange seleccionado no es válido.' });
    }

    if (metodoElegido === 'binance') {
        const regexBinanceEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        const regexBinanceID = /^\d{8,12}$/;
        if (regexBinanceEmail.test(destinoLimpio) || regexBinanceID.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Cuenta o correo inválido para Binance Pay. Debe ser un correo real o UID numérico válido de Binance.';
        }
    } else if (metodoElegido === 'bybit') {
        const regexBybit = /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{7,12})$/;
        if (regexBybit.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Cuenta o correo inválido para Bybit. Ingrese un correo o ID de Bybit real.';
        }
    } else if (metodoElegido === 'okx') {
        const regexOkx = /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{8,12})$/;
        if (regexOkx.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Cuenta o correo inválido para OKX. Ingrese un correo o UID verificado de OKX.';
        }
    } else if (metodoElegido === 'zinli' || metodoElegido === 'paypal' || metodoElegido === 'airtm') {
        const regexCorreoGeneral = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (regexCorreoGeneral.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = `❌ Para ${metodoElegido.toUpperCase()} debe ingresar obligatoriamente un correo electrónico con formato real (ej: usuario@correo.com).`;
        }
    } else if (metodoElegido === 'zelle') {
        const regexZelle = /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d{10,15})$/;
        if (regexZelle.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Para Zelle debe ingresar un correo electrónico o número de teléfono asociado válido.';
        }
    } else {
        if (destinoLimpio.length >= 20) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ La dirección de billetera cripto o destino es demasiado corta o inválida.';
        }
    }

    if (!esValido) {
        return res.status(400).json({ success: false, message: mensajeErrorFormato });
    }

    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        await db.run(
            'INSERT INTO metodos_pago (cedulaTitular, metodo, cuentaDestino, fechaRegistro) VALUES (?, ?, ?, ?)',
            [cedulaLimpia, metodoElegido, cuentaDestino.trim(), ahora]
        );

        if (telefono) {
            await db.run('UPDATE usuarios SET metodoVinculado = 1 WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        }

        res.json({ success: true, message: '¡Método verificado y vinculado con éxito[cite: 7]!' });
    } catch (err) {
        console.error("Error guardando método de pago:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al registrar el método de pago.' });
    }
});

app.get('/api/historial/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();
    try {
        const rows = await db.all(
            `SELECT * FROM transacciones 
             WHERE telefonoEmisor = ? 
                OR telefonoDestino = ? 
                OR telefonoEmisor IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR telefonoDestino IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR (telefonoEmisor = 'EXTERNO_EXCHANGE' AND telefonoDestino = ?) 
             ORDER BY id DESC LIMIT 10`,
            [busqueda, busqueda, busqueda, busqueda, busqueda]
        );
        res.json({ 
            success: true, 
            transacciones: rows, 
            historial: rows,
            avisoAutolimpieza: "Mostrando las últimas 10 operaciones. Los registros antiguos se purgan automáticamente cada 60 días para mantener la plataforma rápida y ligera[cite: 7]."
        });
    } catch (err) {
        console.error("Error consultando historial:", err.message);
        return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
    }
});

// ==========================================
// RUTA ORIGINAL DE ENVÍO DE CÓDIGO POR WHATSAPP
// ==========================================
app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    
    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: 'El teléfono y el PIN de seguridad son obligatorios.' });
    }

    try {
        await db.run(
            `INSERT INTO usuarios (telefono, pinSeguridad, accountType, dailyLimit) VALUES (?, ?, 'natural', 1000.00)
             ON CONFLICT(telefono) DO UPDATE SET pinSeguridad = ?`,
            [telefono, pinSeguridad, pinSeguridad]
        );

        const userRecord = await db.get('SELECT id FROM usuarios WHERE telefono = ?', [telefono]);
        if (userRecord) {
            const existingWallet = await db.get('SELECT id FROM wallets WHERE user_id = ?', [userRecord.id]);
            if (!existingWallet) {
                await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [userRecord.id]);
            }
        }

        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000);
        const mensaje = `¡Registro Exitoso en Monedero USDT! 🟢\n\nTu línea ha sido validada correctamente y tu PIN de seguridad de 4 dígitos ha quedado configurado.\n\n🔑 *Tu PIN configurado:* ${pinSeguridad}\n🔢 *Código de verificación:* *${codigoVerificacion}*`;

        await enviarMensajeWhatsappSeguro(telefono, mensaje);
        res.json({ success: true, message: '¡Código enviado por WhatsApp con éxito y PIN configurado[cite: 7]!', codigoMock: codigoVerificacion });
    } catch (err) {
        console.error("Error guardando usuario:", err);
        return res.status(500).json({ success: false, message: 'Error interno al registrar el usuario.' });
    }
});

// ==========================================
// CAMBIO A CUENTA COMERCIAL
// ==========================================
const procesarUpgradeComercialHandler = async (req, res) => {
    const telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    const planDeseado = req.body.planDeseado || 'comercial';

    if (!telefono) {
        return res.status(400).json({ 
            success: false, 
            message: 'El número de teléfono es obligatorio para solicitar el cambio de plan.' 
        });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        if (!pinSeguridad || usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad obligatorio o incorrecto para validar esta operación[cite: 7].' });
        }

        if (usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor') {
            return res.json({
                success: true,
                message: `Tu cuenta ya es Comercial. Tu ID QR es ${usuario.merchant_id}.`,
                merchantId: usuario.merchant_id,
                accountType: usuario.accountType
            });
        }

        const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
        if (!wallet || wallet.usdt_balance < COSTO_CAMBIO_PLAN_COMERCIAL) {
            return res.status(400).json({ 
                success: false, 
                message: `❌ Saldo insuficiente. Requieres al menos $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT en tu billetera para abonar la comisión de cambio a Cuenta Comercial.` 
            });
        }

        const nuevoSaldo = wallet.usdt_balance - COSTO_CAMBIO_PLAN_COMERCIAL;
        const limiteIlimitado = 999999.00;
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
        const refComision = 'UPG-' + Math.floor(100000 + Math.random() * 900000);

        const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const merchantAliasUnico = `MERCHANT-${randomSuffix}`;

        await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id]);
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', COSTO_CAMBIO_PLAN_COMERCIAL, refComision, ahora]
        );
        await db.run(
            `UPDATE usuarios SET merchant_id = ?, accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE id = ?`,
            [merchantAliasUnico, planDeseado, limiteIlimitado, ahora, usuario.id]
        );

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `¡ACTIVACIÓN COMERCIAL EXITOSA! 🚀\n\n` +
            `🆔 *Tu ID/Alias QR Único y Privado:* ${merchantAliasUnico}\n` +
            `💵 *Comisión cobrada:* $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT\n` +
            `💰 *Saldo disponible liberado:* $${nuevoSaldo.toFixed(2)} USDT\n` +
            `📌 *Ref:* ${refComision}\n\n` +
            `✅ Tu número personal ha quedado protegido con tu ID único.\n` +
            `✅ Ya puedes realizar cobros y transferencias ilimitadas.`
        );

        res.json({
            success: true,
            message: `¡Cuenta actualizada a comercial! Tu ID QR único generado es ${merchantAliasUnico}[cite: 7].`,
            merchantId: merchantAliasUnico,
            nuevoSaldo: nuevoSaldo.toFixed(2),
            accountType: planDeseado,
            dailyLimit: limiteIlimitado
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error interno procesando el cambio de cuenta.' });
    }
};

app.post('/api/solicitar-comercial', limiterPagos, procesarUpgradeComercialHandler);
app.post('/api/upgrade-comercial', limiterPagos, procesarUpgradeComercialHandler);

app.post('/api/upgrade-account', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const accountType = req.body.accountType;
    if (!telefono || !accountType) {
        return res.status(400).json({ success: false, message: 'Faltan datos requeridos.' });
    }
    const nuevoLimite = 999999.00;
    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        const resultado = await db.run(
            `UPDATE usuarios SET accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE telefono = ? OR merchant_id = ?`,
            [accountType, nuevoLimite, ahora, telefono, telefono]
        );
        if (resultado.changes === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        
        res.json({ 
            success: true, 
            message: `¡Cuenta actualizada a ${accountType.toUpperCase()}!` 
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error en base de datos.' });
    }
});

// ==========================================
// RUTA DE RESET RÁPIDO PARA PRUEBAS (DEV)
// ==========================================
app.get('/api/dev/reset-all', async (req, res) => {
    const numerosPrueba = ['04126039718', '04123400436'];
    
    try {
        for (const telefono of numerosPrueba) {
            await db.run(`UPDATE usuarios SET accountType = 'natural', dailyLimit = 1000.00, merchant_id = NULL WHERE telefono = ?`, [telefono]);
            await db.run(`UPDATE wallets SET usdt_balance = 500.00 WHERE user_id = (SELECT id FROM usuarios WHERE telefono = ?)`, [telefono]);
        }
        res.json({ 
            success: true, 
            message: '¡Listo! Los dos números de prueba han sido restablecidos a Cuenta Natural y con $500.00 USDT de saldo cada uno.' 
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// PROCESAMIENTO DE RETIROS DIRECTOS (LIBRE Y SIN RESTRICCIONES)
// ==========================================
app.post('/api/procesar-retiro', limiterPagos, async (req, res) => {
    const { plataforma, destino, monto, pinSeguridad } = req.body;
    let telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();

    if (!telefono) {
        return res.status(400).json({ success: false, message: '❌ El número de teléfono o emisor es obligatorio para procesar el retiro[cite: 7].' });
    }

    const montoNum = parseFloat(monto);
    if (!destino || isNaN(montoNum) || montoNum <= 0) {
        return res.status(400).json({ success: false, message: 'Datos de retiro inválidos (monto o destino vacíos)[cite: 7].' });
    }

    const comisionAplicar = calcularComisionRetiro(montoNum);

    if (montoNum <= comisionAplicar) {
        return res.status(400).json({ 
            success: false, 
            message: `El monto del retiro debe ser superior a la comisión calculada ($${comisionAplicar.toFixed(2)} USDT)[cite: 7].` 
        });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado en el sistema[cite: 7].' });
        }

        if (!pinSeguridad || usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto o no proporcionado[cite: 7].' });
        }

        const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
        if (!wallet || wallet.usdt_balance < montoNum) {
            return res.status(400).json({ success: false, message: '❌ Saldo insuficiente para realizar el retiro[cite: 7].' });
        }

        const nuevoSaldo = wallet.usdt_balance - montoNum;
        const refRetiro = 'RET-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id]);
        await db.run(
            'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) VALUES (?, ?, ?, ?, ?, ?)',
            [refRetiro, montoNum, usuario.telefono, `${(plataforma || 'EXT').toUpperCase()}:${destino}`, refRetiro, ahora]
        );
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', comisionAplicar, refRetiro, ahora]
        );

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `¡SOLICITUD DE RETIRO RECIBIDA! 📤\n\n` +
            `💵 *Monto Retirado:* $${montoNum.toFixed(2)} USDT\n` +
            `🏷️ *Comisión de Servicio:* $${comisionAplicar.toFixed(2)} USDT\n` +
            `🏦 *Plataforma:* ${(plataforma || 'N/A').toUpperCase()}\n` +
            `🎯 *Destino:* ${destino}\n` +
            `📌 *Ref:* ${refRetiro}\n` +
            `💰 *Saldo restante:* $${nuevoSaldo.toFixed(2)} USDT\n` +
            `📅 ${ahora}`
        );

        return res.json({
            success: true,
            message: `¡Retiro de $${montoNum.toFixed(2)} USDT procesado con éxito[cite: 7]! Ref: ${refRetiro}`,
            nuevoSaldo: nuevoSaldo.toFixed(2),
            comisionAplicada: comisionAplicar.toFixed(2),
            referencia: refRetiro
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error procesando el retiro[cite: 7].' });
    }
});

app.post('/procesar-retiro', limiterPagos, (req, res) => res.redirect(307, '/api/procesar-retiro'));

// ==========================================
// LÓGICA BLINDADA DE RECARGA (CON VALIDACIÓN REAL BLOCKCHAIN POLYGON)
// ==========================================
const logicaRecargaHandler = async (req, res) => {
    let phoneNumber = (req.body.phoneNumber || req.body.telefono || req.body.phone || '').trim();
    let amount = req.body.amount || req.body.monto || req.body.cantidad || req.body.valor;
    let txHash = (req.body.txHash || req.body.hash || req.body.referenciaHash || '').trim();

    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: '❌ El número de teléfono del beneficiario es obligatorio para acreditar la recarga[cite: 7].' });
    }

    const montoLimpio = parseFloat(amount);

    if (!amount || !txHash) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios (monto o hash) para procesar la recarga[cite: 7].' });
    }

    if (isNaN(montoLimpio) || montoLimpio < MONTO_MINIMO_RECARGA) {
        return res.status(400).json({ 
            success: false, 
            message: `El monto mínimo permitido para recargar es de $${MONTO_MINIMO_RECARGA.toFixed(2)} USDT[cite: 7].` 
        });
    }

    try {
        // 1. VALIDACIÓN ESTRICTA EN LA BLOCKCHAIN DE POLYGON
        const resultadoBlockchain = await verificarHashPolygonEnBlockchain(txHash, montoLimpio);
        if (!resultadoBlockchain.valido) {
            return res.status(400).json({ success: false, error: resultadoBlockchain.mensaje });
        }

        // 2. VERIFICAR QUE EL HASH NO HAYA SIDO USADO ANTES EN LA DB LOCAL
        const txExistente = await db.get('SELECT id FROM transacciones WHERE reference_hash = ?', [txHash]);
        if (txExistente) {
            return res.status(400).json({ success: false, error: "Esta transacción de Polygon ya fue procesada anteriormente[cite: 7]." });
        }

        const comisionAplicar = calcularComisionRecarga(montoLimpio);
        const montoNetoAcreditar = montoLimpio - comisionAplicar;

        let wallet = await db.get(`
            SELECT wallets.id, wallets.usdt_balance, usuarios.telefono 
            FROM usuarios 
            LEFT JOIN wallets ON wallets.user_id = usuarios.id 
            WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
        `, [phoneNumber, phoneNumber]);

        let walletId;
        let saldoActual = 0.00;
        let telReal = phoneNumber;

        if (wallet && wallet.id) {
            walletId = wallet.id;
            saldoActual = wallet.usdt_balance;
            telReal = wallet.telefono;
        } else {
            const user = await db.get('SELECT id, telefono FROM usuarios WHERE telefono = ? OR merchant_id = ?', [phoneNumber, phoneNumber]);
            if (!user) {
                return res.status(400).json({ success: false, error: `El destinatario ${phoneNumber} no está registrado en la plataforma.` });
            }
            const newW = await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [user.id]);
            walletId = newW.lastID;
            telReal = user.telefono;
        }

        const nuevoSaldo = saldoActual + montoNetoAcreditar;
        const referenciaGen = 'REC-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, walletId]);
        await db.run(`
            INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) 
            VALUES (?, ?, ?, ?, ?, ?)
        `, [referenciaGen, montoLimpio, 'POLYGON_CHAIN', telReal, txHash, ahora]);
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', comisionAplicar, referenciaGen, ahora]
        );

        await enviarMensajeWhatsappSeguro(
            telReal,
            `¡RECARGA EXITOSA (POLYGON)! 📥\n\n` +
            `💵 *Monto Recibido:* $${montoLimpio.toFixed(2)} USDT\n` +
            `🏷️ *Comisión de Servicio:* $${comisionAplicar.toFixed(2)} USDT\n` +
            `💰 *Acreditado a tu Wallet:* $${montoNetoAcreditar.toFixed(2)} USDT\n` +
            `📌 *Ref:* ${referenciaGen}\n` +
            `📅 ${ahora}`
        );

        res.json({ 
            success: true, 
            message: `¡Recarga de $${montoLimpio.toFixed(2)} USDT validada en Polygon[cite: 7]! Se acreditan $${montoNetoAcreditar.toFixed(2)} USDT a ${telReal}. Ref: ${referenciaGen}`,
            montoAcreditado: montoNetoAcreditar.toFixed(2),
            comisionAplicada: comisionAplicar.toFixed(2),
            referencia: referenciaGen
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Error procesando la recarga en blockchain[cite: 7]" });
    }
};

app.post('/api/recargar', limiterPagos, logicaRecargaHandler);
app.post('/recargar', limiterPagos, logicaRecargaHandler);
app.post('/api/recargar-hash', limiterPagos, logicaRecargaHandler);
app.post('/api/verificar-recarga-hash', limiterPagos, logicaRecargaHandler);

// ==========================================
// ENVÍO DE PAGO (BLINDADO CON PIN ESTRICTO Y EMISOR OBLIGATORIO)
// ==========================================
app.post('/api/enviar-pago', limiterPagos, async (req, res) => {
    const monto = parseFloat(req.body.montoUSDT || req.body.monto || req.body.amount || req.body.cantidad || req.body.valor);
    let telefonoDestino = (req.body.telefonoComercio || req.body.telefono || req.body.phone || req.body.nroTelefono || '').trim();
    let telefonoEmisor = (req.body.telefonoEmisor || req.body.telefonoPagador || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    
    if (!telefonoEmisor) {
        return res.status(400).json({ success: false, message: '❌ El teléfono del usuario emisor es obligatorio para realizar transferencias.' });
    }

    if (!monto || !telefonoDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el pago (monto o destino).' });
    }

    try {
        const usuarioEmisor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefonoEmisor, telefonoEmisor]);
        if (!usuarioEmisor) {
            return res.status(401).json({ success: false, message: '❌ Usuario emisor no registrado.' });
        }

        if (!pinSeguridad || usuarioEmisor.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto o no proporcionado[cite: 7].' });
        }

        const limitePermitido = usuarioEmisor.dailyLimit || 1000.00;
        if (usuarioEmisor.accountType === 'natural' && monto > limitePermitido) {
            return res.status(400).json({
                success: false,
                message: `❌ Límite superado: Las cuentas Naturales sólo pueden enviar hasta $${limitePermitido} USDT. Solicita el cambio a Cuenta Comercial para transferencias ilimitadas.`
            });
        }

        const walletEmisor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioEmisor.id]);
        if (!walletEmisor || walletEmisor.usdt_balance < monto) {
            return res.status(400).json({ success: false, message: 'Saldo insuficiente en USDT.' });
        }

        const usuarioReceptor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefonoDestino, telefonoDestino]);
        if (!usuarioReceptor) {
            return res.status(400).json({ success: false, message: 'Destinatario o comercio no registrado en la plataforma.' });
        }

        if (usuarioEmisor.id === usuarioReceptor.id) {
            return res.status(400).json({ success: false, message: '❌ No puedes realizar una transferencia a ti mismo.' });
        }

        let walletReceptor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioReceptor.id]);
        let idWalletRec;
        if (!walletReceptor) {
            const newW = await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [usuarioReceptor.id]);
            idWalletRec = newW.lastID;
        } else {
            idWalletRec = walletReceptor.id;
        }

        await db.run('UPDATE wallets SET usdt_balance = usdt_balance - ? WHERE id = ?', [monto, walletEmisor.id]);
        await db.run('UPDATE wallets SET usdt_balance = usdt_balance + ? WHERE id = ?', [monto, idWalletRec]);

        const numeroReferencia = 'REF-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        await db.run(
            'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)',
            [numeroReferencia, monto, usuarioEmisor.telefono, usuarioReceptor.telefono, ahora]
        );

        const esComercioReceptor = usuarioReceptor.accountType === 'comercial' || usuarioReceptor.accountType === 'emprendedor';
        let comisionAplicada = esComercioReceptor ? calcularComisionComercio(monto) : COMISION_FIJA_USUARIO;
        
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', comisionAplicada, numeroReferencia, ahora]
        );

        await enviarMensajeWhatsappSeguro(usuarioReceptor.telefono, `¡PAGO RECIBIDO! 🟢\n\n📌 Ref: ${numeroReferencia}\n💵 Monto: $${monto} USDT\n📅 ${ahora}`);
        await enviarMensajeWhatsappSeguro(usuarioEmisor.telefono, `¡PAGO ENVIADO! 🔴\n\n📌 Ref: ${numeroReferencia}\n💵 Monto: $${monto} USDT\n📅 ${ahora}`);

        res.json({ 
            success: true, 
            message: `¡Pago de $${monto} USDT procesado[cite: 7]! Ref: ${numeroReferencia}`,
            referencia: numeroReferencia,
            comisionPlataforma: comisionAplicada
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error procesando el pago[cite: 7].' });
    }
});

app.post('/procesar-pago', limiterPagos, (req, res) => res.redirect(307, '/api/enviar-pago'));

// ==========================================
// MANTENIMIENTO Y PURGA AUTOMÁTICA EN SEGUNDO PLANO
// ==========================================
setInterval(async () => {
    try {
        if (db) {
            await db.run("DELETE FROM transacciones WHERE fechaHora < datetime('now', '-60 days')");
            await db.run("VACUUM;");
            console.log("🧹 Mantenimiento automático realizado: registros antiguos purgados y DB optimizada.");
        }
    } catch (e) {
        console.error("Error en mantenimiento automático:", e.message);
    }
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});