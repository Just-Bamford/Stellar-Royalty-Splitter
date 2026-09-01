output "vpc_id" {
  description = "VPC identifier."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block, for security group rules in other modules."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnets — load balancer and NAT only."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnets — application instances."
  value       = aws_subnet.private[*].id
}

output "availability_zones" {
  description = "AZs this VPC spans."
  value       = local.azs
}

output "nat_gateway_ips" {
  description = "Elastic IPs of the NAT gateways. These are the source addresses outbound traffic appears from, so they are what an external allowlist needs."
  value       = aws_eip.nat[*].public_ip
}
