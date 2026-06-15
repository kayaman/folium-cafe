variable "domain_name" {
  type    = string
  default = "folium.cafe"
}

variable "hosted_zone_name" {
  type    = string
  default = "folium.cafe"
}

variable "github_repo" {
  type    = string
  default = "kayaman/folium-cafe"
}

variable "name_prefix" {
  type    = string
  default = "folium-cafe"
}

variable "bedrock_model_id" {
  description = "Bedrock cross-region inference-profile id for the metadata-extraction model (us-east-1). The account owner MUST enable model access in the Bedrock console and set this to a vision-capable Claude profile the account can invoke, e.g. a 'us.anthropic.claude-...' profile. Find valid ids with: aws bedrock list-inference-profiles --region us-east-1."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6-v1:0"
}
