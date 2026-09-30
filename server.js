require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Requerido por Railway para lectura de IPs tras proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE CLÁSICO)
// ==========================================
const dbPath = path.resolve(__dirname, 'monedero.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error al conectar con SQLite:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite exitosamente.');
    }
});

// Inicializar tablas completas
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telefono TEXT UNIQUE,
            pinSeguridad TEXT,
            accountType TEXT DEFAULT 'natural',
            dailyLimit REAL DEFAULT 1000.00,
            upgradedAt TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            usdt_balance REAL DEFAULT 0.00,
            FOREIGN KEY(user_id) REFERENCES usuarios(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transacciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referencia TEXT,
            monto REAL,
            telefonoEmisor TEXT,
            telefonoDestino TEXT,
            reference_hash TEXT UNIQUE,
            fechaHora TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS metodos_pago (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedulaTitular TEXT,
            metodo TEXT,
            cuentaDestino TEXT,
            fechaRegistro TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS comisiones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT,
            monto REAL,
            referencia TEXT,
            fechaHora TEXT
        )
    `);
});

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD DIFERENCIADA)
// ==========================================

// 1. Limiter para operaciones sensibles (Pagos, Recargas, Registro de Métodos)
const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 30, // 30 transacciones/recargas por ventana
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes procesadas. Por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// 2. Limiter para consultas en vivo del comercio (Polling continuo del Historial y Saldo)
const limiterConsultasComercio = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 120, // Permite hasta 120 consultas por minuto
    standardHeaders: true,
    legacyHeaders: false,
});

// 3. Limiter General holgado para assets estáticos y navegación de la app
const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000 
});

app.use(limiterGeneral);

const publicPath = path.resolve(__dirname, 'frontend', 'public');
app.use(express.static(publicPath));
app.use('/public', express.static(publicPath));

// ==========================================
// PARÁMETROS Y TARIFAS DE PLATAFORMA
// ==========================================
const PAYPAL_RECEIVER_EMAIL = process.env.PAYPAL_RECEIVER_EMAIL || 'pagos@mipasarela.com';
const BINANCE_COMMISSION_WALLET = process.env.BINANCE_COMMISSION_WALLET || 'Binance Pay / Wallet ID';

const COMISION_FIJA_USUARIO = 1.00;         
const COMISION_PORCENTAJE_COMERCIO = 0.03;  
const COMISION_MINIMA_COMERCIO = 2.00;      
const COSTO_CAMBIO_PLAN_COMERCIAL = 5.00; // Tarifa ($5 USDT) por cambio a Comercial

function calcularComisionComercio(montoVenta) {
    let comisionCalculada = parseFloat(montoVenta) * COMISION_PORCENTAJE_COMERCIO;
    if (comisionCalculada < COMISION_MINIMA_COMERCIO) {
        return COMISION_MINIMA_COMERCIO; 
    }
    return Number(comisionCalculada.toFixed(2)); 
}

function formatearNumeroWhatsapp(numero) {
    if (!numero) return null;
    let numLimpio = numero.toString().trim().replace(/\D/g, ''); 
    if (numLimpio.startsWith('0')) {
        numLimpio = numLimpio.substring(1);
    }
    return numLimpio.startsWith('58') ? `${numLimpio}@c.us` : `58${numLimpio}@c.us`;
}

// ==========================================
// CLIENTE DE WHATSAPP
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
    console.log('¡Cliente de WhatsApp conectado y listo para enviar mensajes!');
});

client.initialize();

// ==========================================
// RUTAS DE PÁGINAS (VISTAS)
// ==========================================

// La página principal localhost:3000/ abre Registro/Autenticación
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

// El panel principal con saldo y cobros queda en /panel
app.get('/panel', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

// Ruta explícita para autenticación
app.get('/auth', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

app.get('/recarga', (req, res) => {
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

app.get('/api/admin/balance', (req, res) => {
    db.get('SELECT SUM(usdt_balance) AS totalUsuarios FROM wallets', [], (err, rowWallets) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        db.get("SELECT SUM(monto) AS totalPayPal FROM comisiones WHERE tipo = 'paypal'", [], (errP, rowPayPal) => {
            db.get("SELECT SUM(monto) AS totalBinance FROM comisiones WHERE tipo = 'binance'", [], (errB, rowBinance) => {
                
                const saldoUsuarios = rowWallets && rowWallets.totalUsuarios ? rowWallets.totalUsuarios : 0;
                const gananciaPayPal = rowPayPal && rowPayPal.totalPayPal ? rowPayPal.totalPayPal : 0;
                const gananciaBinance = rowBinance && rowBinance.totalBinance ? rowBinance.totalBinance : 0;
                const totalGananciasMias = gananciaPayPal + gananciaBinance;

                res.json({
                    success: true,
                    saldoUsuarios: saldoUsuarios.toFixed(2),
                    gananciaPayPal: gananciaPayPal.toFixed(2),
                    gananciaBinance: gananciaBinance.toFixed(2),
                    totalGanancias: totalGananciasMias.toFixed(2)
                });
            });
        });
    });
});

app.get('/api/saldo/:telefono', limiterConsultasComercio, (req, res) => {
    const telefono = req.params.telefono;

    db.get(`
        SELECT usuarios.telefono, usuarios.accountType, usuarios.dailyLimit, wallets.usdt_balance 
        FROM usuarios 
        LEFT JOIN wallets ON usuarios.id = wallets.user_id 
        WHERE usuarios.telefono = ?
    `, [telefono], (err, row) => {
        if (err) {
            console.error("Error consultando saldo:", err.message);
            return res.status(500).json({ success: false, message: 'Error interno al consultar saldo.' });
        }

        if (!row) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        res.json({
            success: true,
            telefono: row.telefono,
            accountType: row.accountType,
            dailyLimit: row.dailyLimit || 1000.00,
            saldoUSDT: row.usdt_balance || 0.00
        });
    });
});

app.post('/api/registrar-metodos', limiterPagos, (req, res) => {
    const { cedulaTitular, metodo, cuentaDestino } = req.body;

    if (!cedulaTitular || !metodo || !cuentaDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para vincular el método.' });
    }

    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    db.run(
        'INSERT INTO metodos_pago (cedulaTitular, metodo, cuentaDestino, fechaRegistro) VALUES (?, ?, ?, ?)',
        [cedulaTitular, metodo, cuentaDestino, ahora],
        function(err) {
            if (err) {
                console.error("Error guardando método de pago:", err.message);
                return res.status(500).json({ success: false, message: 'Error interno al registrar el método de pago.' });
            }
            res.json({ success: true, message: '¡Método vinculado con éxito y de forma segura!' });
        }
    );
});

app.get('/api/historial/:telefono', limiterConsultasComercio, (req, res) => {
    const telefono = req.params.telefono;
    db.all(
        'SELECT * FROM transacciones WHERE telefonoEmisor = ? OR telefonoDestino = ? ORDER BY id DESC',
        [telefono, telefono],
        (err, rows) => {
            if (err) {
                console.error("Error consultando historial:", err.message);
                return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
            }
            res.json({ success: true, transacciones: rows, historial: rows });
        }
    );
});

app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    const { telefono, pinSeguridad } = req.body;
    
    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: 'El teléfono y el PIN de seguridad son obligatorios.' });
    }

    db.run(
        `INSERT INTO usuarios (telefono, pinSeguridad, accountType, dailyLimit) VALUES (?, ?, 'natural', 1000.00)
         ON CONFLICT(telefono) DO UPDATE SET pinSeguridad = ?`,
        [telefono, pinSeguridad, pinSeguridad],
        async function(err) {
            if (err) {
                console.error("Error guardando usuario:", err);
                return res.status(500).json({ success: false, message: 'Error interno al registrar el usuario.' });
            }

            db.get('SELECT id FROM usuarios WHERE telefono = ?', [telefono], async (errUser, userRecord) => {
                if (userRecord) {
                    db.get('SELECT id FROM wallets WHERE user_id = ?', [userRecord.id], async (errW, existingWallet) => {
                        if (!existingWallet) {
                            db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [userRecord.id]);
                        }
                    });
                }
            });

            const codigoVerificacion = Math.floor(100000 + Math.random() * 900000);
            let chatId = formatearNumeroWhatsapp(telefono);
            const mensaje = `¡Registro Exitoso en Monedero USDT! 🟢\n\nTu línea ha sido validada correctamente y tu PIN de seguridad de 4 dígitos ha quedado configurado.\n\n🔑 *Tu PIN configurado:* ${pinSeguridad}\n🔢 *Código de verificación:* *${codigoVerificacion}*`;

            if (chatId) {
                try { await client.sendMessage(chatId, mensaje); } catch(e){}
            }
            res.json({ success: true, message: '¡Código enviado por WhatsApp con éxito y PIN configurado!', codigoMock: codigoVerificacion });
        }
    );
});

// ==========================================
// CAMBIO A CUENTA COMERCIAL CON COBRO DE COMISIÓN ($5 USDT)
// ==========================================
app.post('/api/solicitar-comercial', limiterPagos, (req, res) => {
    const { telefono, pinSeguridad, planDeseado } = req.body;

    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ 
            success: false, 
            message: 'El número de teléfono y el PIN son obligatorios para solicitar el cambio de plan.' 
        });
    }

    db.get('SELECT * FROM usuarios WHERE telefono = ?', [telefono], (err, usuario) => {
        if (err || !usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        if (usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
        }

        if (usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor') {
            return res.status(400).json({ success: false, message: 'Este usuario ya posee una cuenta Comercial activa.' });
        }

        db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id], (errW, wallet) => {
            if (!wallet || wallet.usdt_balance < COSTO_CAMBIO_PLAN_COMERCIAL) {
                return res.status(400).json({ 
                    success: false, 
                    message: `❌ Saldo insuficiente. Requieres al menos $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT en tu billetera para abonar la comisión de cambio a Cuenta Comercial.` 
                });
            }

            const nuevoSaldo = wallet.usdt_balance - COSTO_CAMBIO_PLAN_COMERCIAL;
            const tipoPlan = planDeseado || 'comercial';
            const limiteIlimitado = 999999.00;
            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
            const refComision = 'UPG-' + Math.floor(100000 + Math.random() * 900000);

            // 1. Debitar tarifa de comisión de la billetera
            db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id], (errUpWallet) => {
                if (errUpWallet) {
                    return res.status(500).json({ success: false, message: 'Error debitando la comisión.' });
                }

                // 2. Registrar la comisión ganada en la base de datos para el panel /admin
                db.run(
                    'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                    ['binance', COSTO_CAMBIO_PLAN_COMERCIAL, refComision, ahora]
                );

                // 3. Elevar cuenta a Comercial y remover restricción de $1,000 USDT
                db.run(
                    `UPDATE usuarios SET accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE id = ?`,
                    [tipoPlan, limiteIlimitado, ahora, usuario.id],
                    function(errUpdate) {
                        if (errUpdate) {
                            return res.status(500).json({ success: false, message: 'Error actualizando tipo de cuenta.' });
                        }

                        // 4. Confirmación vía WhatsApp
                        try {
                            let chatId = formatearNumeroWhatsapp(telefono);
                            if (chatId) {
                                client.sendMessage(
                                    chatId, 
                                    `¡ACTIVACIÓN COMERCIAL EXITOSA! 🚀\n\n` +
                                    `💵 *Comisión cobrada:* $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT\n` +
                                    `💰 *Saldo disponible liberado:* $${nuevoSaldo.toFixed(2)} USDT\n` +
                                    `📌 *Ref:* ${refComision}\n\n` +
                                    `✅ Tu límite diario de $1,000 USDT ha sido eliminado.\n` +
                                    `✅ Ya puedes realizar cobros y transferencias ilimitadas.`
                                );
                            }
                        } catch(e){}

                        res.json({
                            success: true,
                            message: `¡Cuenta actualizada a ${tipoPlan.toUpperCase()}! Se descontaron $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT de comisión y tu saldo quedó totalmente libre.`,
                            nuevoSaldo: nuevoSaldo.toFixed(2),
                            accountType: tipoPlan,
                            dailyLimit: limiteIlimitado
                        });
                    }
                );
            });
        });
    });
});

// Alias alternativo de actualización directa
app.post('/api/upgrade-account', limiterPagos, (req, res) => {
    const { telefono, accountType } = req.body;
    if (!telefono || !accountType) {
        return res.status(400).json({ success: false, message: 'Faltan datos requeridos.' });
    }
    const nuevoLimite = 999999.00;
    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    db.run(
        `UPDATE usuarios SET accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE telefono = ?`,
        [accountType, nuevoLimite, ahora, telefono],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: 'Error en base de datos.' });
            if (this.changes === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
            
            res.json({ 
                success: true, 
                message: `¡Cuenta actualizada a ${accountType.toUpperCase()}!` 
            });
        }
    );
});

// ==========================================
// LÓGICA BLINDADA DE RECARGA
// ==========================================
const logicaRecargaHandler = (req, res) => {
    let phoneNumber = req.body.phoneNumber || req.body.telefono || req.body.phone;
    let amount = req.body.amount || req.body.monto || req.body.cantidad || req.body.valor;
    let txHash = req.body.txHash || req.body.hash || req.body.referenciaHash;

    const procesarConTelefono = (telObjetivo) => {
        const montoLimpio = parseFloat(amount);

        if (!amount || !txHash) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios (monto o hash) para procesar la recarga.' });
        }
        
        if (isNaN(montoLimpio) || montoLimpio <= 0) {
            return res.status(400).json({ success: false, message: 'El monto ingresado es inválido.' });
        }

        db.get('SELECT id FROM transacciones WHERE reference_hash = ?', [txHash], (err, txExistente) => {
            if (txExistente) {
                return res.status(400).json({ success: false, error: "Esta transacción ya fue procesada anteriormente." });
            }

            db.get(`
                SELECT wallets.id, wallets.usdt_balance FROM wallets 
                JOIN usuarios ON wallets.user_id = usuarios.id 
                WHERE usuarios.telefono = ?
            `, [telObjetivo], (errWallet, wallet) => {
                
                if (wallet) {
                    const nuevoSaldo = wallet.usdt_balance + montoLimpio;
                    const referenciaGen = 'REC-' + Math.floor(100000 + Math.random() * 900000);
                    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

                    db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id], (errUp) => {
                        if (errUp) return res.status(500).json({ success: false, error: "Error actualizando saldo" });

                        db.run(`
                            INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) 
                            VALUES (?, ?, ?, ?, ?, ?)
                        `, [referenciaGen, montoLimpio, 'EXTERNO_EXCHANGE', telObjetivo, txHash, ahora], (errIns) => {
                            if (errIns) return res.status(500).json({ success: false, error: "Error guardando transacción" });
                            res.json({ success: true, message: `¡Recarga exitosa de ${montoLimpio} USDT acreditada a ${telObjetivo}! Ref: ${referenciaGen}` });
                        });
                    });
                } else {
                    db.get('SELECT id FROM usuarios WHERE telefono = ?', [telObjetivo], (errU, user) => {
                        if (!user) {
                            return res.status(400).json({ success: false, error: `El número de teléfono ${telObjetivo} no está registrado en la plataforma.` });
                        }
                        db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, ?)', [user.id, montoLimpio], function(errNewW) {
                            if (errNewW) return res.status(500).json({ success: false, error: "Error creando monedero" });
                            
                            const referenciaGen = 'REC-' + Math.floor(100000 + Math.random() * 900000);
                            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

                            db.run(`
                                INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) 
                                VALUES (?, ?, ?, ?, ?, ?)
                            `, [referenciaGen, montoLimpio, 'EXTERNO_EXCHANGE', telObjetivo, txHash, ahora], () => {
                                res.json({ success: true, message: `¡Recarga exitosa de ${montoLimpio} USDT acreditada a ${telObjetivo}! Ref: ${referenciaGen}` });
                            });
                        });
                    });
                }
            });
        });
    };

    if (!phoneNumber) {
        db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1', [], (err, rowUser) => {
            if (rowUser && rowUser.telefono) {
                procesarConTelefono(rowUser.telefono);
            } else {
                return res.status(400).json({ success: false, message: 'No hay usuarios registrados en la base de datos para acreditar la recarga.' });
            }
        });
    } else {
        procesarConTelefono(phoneNumber);
    }
};

app.post('/api/recargar', limiterPagos, logicaRecargaHandler);
app.post('/api/verificar-recarga-hash', limiterPagos, logicaRecargaHandler);

// ==========================================
// ENVÍO DE PAGO CON CONTROL DE LÍMITE
// ==========================================
app.post('/api/enviar-pago', limiterPagos, (req, res) => {
    const monto = parseFloat(req.body.montoUSDT || req.body.monto || req.body.amount || req.body.cantidad || req.body.valor);
    const telefonoDestino = req.body.telefonoComercio || req.body.telefono || req.body.phone || req.body.nroTelefono;
    let telefonoEmisor = req.body.telefonoEmisor || req.body.telefonoPagador || req.body.telefonoUsuario;
    const pinSeguridad = req.body.pinSeguridad;
    const esComercio = req.body.esComercio || false; 
    
    if (!monto || !telefonoDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el pago (monto o destino).' });
    }

    const ejecutarEnvioConEmisor = (telEmisorFinal) => {
        db.get('SELECT * FROM usuarios WHERE telefono = ?', [telEmisorFinal], (errU, usuarioEmisor) => {
            if (!usuarioEmisor) {
                return res.status(401).json({ success: false, message: '❌ Usuario emisor no registrado.' });
            }

            if (pinSeguridad && usuarioEmisor.pinSeguridad && usuarioEmisor.pinSeguridad !== pinSeguridad) {
                return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
            }

            // Validar límite diario ($1,000 USDT para Persona Natural)
            const limitePermitido = usuarioEmisor.dailyLimit || 1000.00;
            if (usuarioEmisor.accountType === 'natural' && monto > limitePermitido) {
                return res.status(400).json({
                    success: false,
                    message: `❌ Límite superado: Las cuentas Naturales sólo pueden enviar hasta $${limitePermitido} USDT. Solicita el cambio a Cuenta Comercial para transferencias ilimitadas.`
                });
            }

            db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioEmisor.id], (errW, walletEmisor) => {
                if (!walletEmisor || walletEmisor.usdt_balance < monto) {
                    return res.status(400).json({ success: false, message: 'Saldo insuficiente en USDT.' });
                }

                db.get('SELECT * FROM usuarios WHERE telefono = ?', [telefonoDestino], (errReceptor, usuarioReceptor) => {
                    if (!usuarioReceptor) {
                        return res.status(400).json({ success: false, message: 'Destinatario no registrado.' });
                    }

                    db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioReceptor.id], (errWRec, walletReceptor) => {
                        
                        const procesarTrxFinal = (idWalletRec) => {
                            db.run('UPDATE wallets SET usdt_balance = usdt_balance - ? WHERE id = ?', [monto, walletEmisor.id]);
                            db.run('UPDATE wallets SET usdt_balance = usdt_balance + ? WHERE id = ?', [monto, idWalletRec]);

                            const numeroReferencia = 'REF-' + Math.floor(100000 + Math.random() * 900000);
                            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

                            db.run(
                                'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)',
                                [numeroReferencia, monto, telEmisorFinal, telefonoDestino, ahora]
                            );

                            let comisionAplicada = esComercio ? calcularComisionComercio(monto) : COMISION_FIJA_USUARIO;
                            let tipoComision = esComercio ? 'binance' : 'paypal';
                            
                            db.run(
                                'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                                [tipoComision, comisionAplicada, numeroReferencia, ahora]
                            );

                            try {
                                let chatIdDestino = formatearNumeroWhatsapp(telefonoDestino);
                                if (chatIdDestino) client.sendMessage(chatIdDestino, `¡PAGO RECIBIDO! 🟢\n\n📌 Ref: ${numeroReferencia}\n💵 Monto: $${monto} USDT\n📅 ${ahora}`);
                            } catch(e){}

                            try {
                                let chatIdEmisor = formatearNumeroWhatsapp(telEmisorFinal);
                                if (chatIdEmisor) client.sendMessage(chatIdEmisor, `¡PAGO ENVIADO! 🔴\n\n📌 Ref: ${numeroReferencia}\n💵 Monto: $${monto} USDT\n📅 ${ahora}`);
                            } catch(e){}

                            let destinoComision = esComercio ? `Binance (${BINANCE_COMMISSION_WALLET})` : `PayPal (${PAYPAL_RECEIVER_EMAIL})`;

                            res.json({ 
                                success: true, 
                                message: `¡Pago de $${monto} USDT procesado! Ref: ${numeroReferencia}`,
                                referencia: numeroReferencia,
                                comisionPlataforma: comisionAplicada,
                                destinoComision: destinoComision
                            });
                        };

                        if (!walletReceptor) {
                            db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [usuarioReceptor.id], function(errNew) {
                                procesarTrxFinal(this.lastInsertRowid);
                            });
                        } else {
                            procesarTrxFinal(walletReceptor.id);
                        }
                    });
                });
            });
        });
    };

    if (!telefonoEmisor) {
        db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1', [], (err, rowUser) => {
            if (rowUser && rowUser.telefono) {
                ejecutarEnvioConEmisor(rowUser.telefono);
            } else {
                return res.status(400).json({ success: false, message: 'No hay un usuario emisor registrado en la plataforma.' });
            }
        });
    } else {
        ejecutarEnvioConEmisor(telefonoEmisor);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});