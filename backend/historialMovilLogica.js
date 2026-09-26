// Módulo de Historial de Transacciones
const express = require('express');
const router = express.Router();

async function obtenerHistorialUsuario(phoneNumber, clientDb) {
    try {
        // Consultar todas las transacciones donde el número sea emisor o receptor
        const transacciones = await clientDb('transactions')
            .where('sender_phone', phoneNumber)
            .orWhere('receiver_phone', phoneNumber)
            .orderBy('timestamp', 'desc')
            .limit(50); // Mostramos las últimas 50 para mantener la velocidad

        return { 
            success: true, 
            data: transacciones 
        };

    } catch (error) {
        return { 
            success: false, 
            error: "No se pudo cargar el historial de transacciones." 
        };
    }
}

// Ejemplo de endpoint GET para consultar el historial por el número de teléfono
router.get('/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        // Aquí puedes pasar tu conexión a base de datos real si usas Knex/SQL
        const resultado = await obtenerHistorialUsuario(phone, req.db);
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ success: false, error: "Error interno del servidor" });
    }
});

// Exportar el router para Express
module.exports = router;