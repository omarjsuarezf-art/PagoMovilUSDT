// Módulo de Pago Móvil en USDT
const express = require('express');
const router = express.Router();

// Función para procesar un pago móvil en USDT usando números de teléfono
async function realizarPagoMovil(senderPhone, receiverPhone, amount, clientDb) {
  // 1. Validar que no se intente pagar a sí mismo
  if (senderPhone === receiverPhone) {
    throw new Error("No puedes enviarte dinero a ti mismo.");
  }

  // Abrimos una transacción segura en la base de datos
  const trx = await clientDb.transaction();

  try {
    // 2. Buscar al emisor por su número de teléfono
    const senderWallet = await trx('wallets')
      .join('users', 'wallets.user_id', 'users.id')
      .where('users.phone_number', senderPhone)
      .select('wallets.id', 'wallets.usdt_balance')
      .first();

    if (!senderWallet) {
      throw new Error("El número emisor no está registrado.");
    }

    // 3. Verificar si el emisor tiene suficiente saldo en USDT
    if (Number(senderWallet.usdt_balance) < Number(amount)) {
      throw new Error("Saldo insuficiente en USDT.");
    }

    // 4. Buscar al receptor por su número de teléfono
    const receiverWallet = await trx('wallets')
      .join('users', 'wallets.user_id', 'users.id')
      .where('users.phone_number', receiverPhone)
      .select('wallets.id', 'wallets.usdt_balance')
      .first();

    if (!receiverWallet) {
      throw new Error("El número de teléfono destino no está registrado en la plataforma.");
    }

    // 5. Calcular la comisión para ti como creador (ej: 0.6%)
    const feePercentage = 0.006; 
    const feeAmount = Number(amount) * feePercentage;
    const netAmountToReceiver = Number(amount) - feeAmount;

    // 6. Descontar el total del saldo del emisor
    await trx('wallets')
      .where('id', senderWallet.id)
      .decrement('usdt_balance', amount);

    // 7. Sumar el monto neto al receptor
    await trx('wallets')
      .where('id', receiverWallet.id)
      .increment('usdt_balance', netAmountToReceiver);

    // 8. Guardar el registro en la tabla de transacciones (¡incluyendo tu ganancia por comisión!)
    await trx('transactions').insert({
      sender_phone: senderPhone,
      receiver_phone: receiverPhone,
      amount: amount,
      fee_collected: feeAmount,
      status: 'completed',
      timestamp: new Date()
    });

    // Si todo salió bien, confirmamos los cambios en la base de datos
    await trx.commit();
    return { success: true, message: "¡Pago móvil procesado con éxito!", feeEarned: feeAmount };

  } catch (error) {
    // Si algo falla, se revierte todo para proteger los fondos
    await trx.rollback();
    return { success: false, error: error.message };
  }
}

// Ruta POST ajustada a /enviar-pago para empalmar con el frontend
router.post('/enviar-pago', async (req, res) => {
    try {
        const { telefonoEmisor, telefonoComercio, montoUSDT, pinSeguridad } = req.body;

        // 1. Validación estricta: si no hay emisor válido, rechazamos con 401
        if (!telefonoEmisor || telefonoEmisor.trim() === '') {
            return res.status(401).json({ success: false, message: "Sesión no válida o expirada. Por favor, inicia sesión." });
        }

        // 2. Validación de PIN ingresado desde el frontend
        if (!pinSeguridad) {
            return res.status(400).json({ success: false, message: "El PIN de seguridad es obligatorio." });
        }

        // 3. Verificar el PIN del usuario en la base de datos
        const usuario = await req.db('users')
            .where('phone_number', telefonoEmisor)
            .first();

        if (!usuario || usuario.pin !== pinSeguridad) {
            return res.status(401).json({ success: false, message: "PIN de seguridad incorrecto." });
        }

        // 4. Ejecutar la transacción en la base de datos
        const resultado = await realizarPagoMovil(telefonoEmisor, telefonoComercio, montoUSDT, req.db);
        
        if (!resultado.success) {
            return res.status(400).json({ success: false, message: resultado.error });
        }

        res.json({ success: true, message: resultado.message, feeEarned: resultado.feeEarned });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error interno procesando el pago." });
    }
});

// Exportar el router para Express
module.exports = router;