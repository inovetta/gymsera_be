-- Creates the tenant application user with privileges to manage databases.
-- This user is granted access to each tenant database individually by TenantProvisioningService.
CREATE USER IF NOT EXISTS 'gymsera_tenant'@'%' IDENTIFIED BY 'tenant_pass';
FLUSH PRIVILEGES;
