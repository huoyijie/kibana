/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { pick, identity } from 'lodash';
import Joi from 'joi';
import { wrapError } from '../../../../lib/errors';
import { ALL_RESOURCE } from '../../../../../common/constants';

const transformKibanaPrivilegesToEs = (application, kibanaPrivileges) => {
  const kibanaApplicationPrivileges = [];
  if (kibanaPrivileges.global && kibanaPrivileges.global.length) {
    kibanaApplicationPrivileges.push({
      privileges: kibanaPrivileges.global,
      application,
      resources: [ALL_RESOURCE],
    });
  }

  if (kibanaPrivileges.space) {
    for (const [spaceId, privileges] of Object.entries(kibanaPrivileges.space)) {
      kibanaApplicationPrivileges.push({
        privileges: privileges,
        application,
        resources: [`space:${spaceId}`]
      });
    }
  }

  return kibanaApplicationPrivileges;
};

const transformRolesToEs = (
  application,
  payload,
  existingApplications = []
) => {
  const { elasticsearch = {}, kibana = {} } = payload;
  const otherApplications = existingApplications.filter(
    roleApplication => roleApplication.application !== application
  );

  return pick({
    metadata: payload.metadata,
    cluster: elasticsearch.cluster || [],
    indices: elasticsearch.indices || [],
    run_as: elasticsearch.run_as || [],
    applications: [
      ...transformKibanaPrivilegesToEs(application, kibana),
      ...otherApplications,
    ],
  }, identity);
};

export function initPutRolesApi(
  server,
  callWithRequest,
  routePreCheckLicenseFn,
  privilegeMap,
  application
) {

  const schema = Joi.object().keys({
    metadata: Joi.object().optional(),
    elasticsearch: Joi.object().keys({
      cluster: Joi.array().items(Joi.string()),
      indices: Joi.array().items({
        names: Joi.array().items(Joi.string()),
        field_security: Joi.object().keys({
          grant: Joi.array().items(Joi.string()),
          except: Joi.array().items(Joi.string()),
        }),
        privileges: Joi.array().items(Joi.string()),
        query: Joi.string().allow(''),
      }),
      run_as: Joi.array().items(Joi.string()),
    }),
    kibana: Joi.object().keys({
      global: Joi.array().items(Joi.string().valid(Object.keys(privilegeMap))),
      space: Joi.object().pattern(/^/, Joi.array().items(Joi.string().valid(Object.keys(privilegeMap))))
    })
  });

  server.route({
    method: 'PUT',
    path: '/api/security/role/{name}',
    async handler(request, reply) {
      const name = request.params.name;
      try {
        const existingRoleResponse = await callWithRequest(request, 'shield.getRole', {
          name,
          ignore: [404],
        });

        const body = transformRolesToEs(
          application,
          request.payload,
          existingRoleResponse[name] ? existingRoleResponse[name].applications : []
        );

        await callWithRequest(request, 'shield.putRole', { name, body });
        reply().code(204);
      } catch (err) {
        reply(wrapError(err));
      }
    },
    config: {
      validate: {
        params: Joi.object()
          .keys({
            name: Joi.string()
              .required()
              .min(1)
              .max(1024),
          })
          .required(),
        payload: schema,
      },
      pre: [routePreCheckLicenseFn],
    },
  });
}