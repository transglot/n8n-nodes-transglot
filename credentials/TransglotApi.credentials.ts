import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
    Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Credentials for the transglot deploy-token API.
 *
 * A transglot deploy token IS the project (deploy-key model) — there is no project
 * id in any URL. The token is sent as `Authorization: Bearer <token>`; `baseUrl` points
 * at the user's install and every request is made under `{baseUrl}/v1/...`.
 *
 * The `test` request hits `GET {baseUrl}/v1/project`, which any valid deploy token
 * (push / pull / manage / read+write) can read — so "Test" is a true reachability +
 * auth check without mutating anything.
 */
export class TransglotApi implements ICredentialType {
	name = 'transglotApi';

	displayName = 'Transglot API';

    icon: Icon = { light: 'file:transglot.svg', dark: 'file:transglot.svg' };

	documentationUrl = 'https://transglot.ai';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.transglot.ai',
			required: true,
			placeholder: 'https://api.transglot.ai',
			description:
				'Root of the transglot API, with no /api segment (it was removed when the API moved to its own host). All calls are made under {baseUrl}/v1/...',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'A project deploy token minted in the web app (starts with tgl_). The token identifies the project, so no project id is needed anywhere.',
		},
	];

	// Generic bearer auth: the token is injected as an Authorization header on every
	// request the nodes make through httpRequestWithAuthentication.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	// "Test" button: a 200 from GET /v1/project confirms the URL, token, and project.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/project',
			method: 'GET',
		},
	};
}
