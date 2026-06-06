const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Device',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Cross-DB reference to a branch in the tenant's database
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // ZKTeco device serial number — this is what the device sends in ADMS requests
      serialNumber: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
        comment: 'Friendly name e.g. "Main Gate Reader"',
      },
      model: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Device model e.g. ZK-F22, ZKTeco-UA860',
      },
      ipAddress: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Local IP of the device (for reference/diagnostics)',
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Timestamp of last ADMS heartbeat from the device',
      },
      // ZKTeco ADMS uses a "Stamp" (Unix-like timestamp) to track which records
      // the device has already uploaded. We store the last received stamp here
      // so we can tell the device to only send newer records next time.
      lastSyncStamp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'devices',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'devices_serial_number_unique', unique: true, fields: ['serial_number'] },
        { fields: ['tenant_id'] },
        { fields: ['branch_id'] },
        { fields: ['status'] },
      ],
    }
  );
};
